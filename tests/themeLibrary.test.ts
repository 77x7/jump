import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CUSTOM_THEMES,
  buildThemesFile,
  importThemes,
  parseCustomThemes,
  parseThemeOverrides,
} from "../src/themeLibrary.ts";
import type { CustomTheme } from "../src/types.ts";

function theme(id: string, name = "Theme", extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    base: "nord",
    scheme: "dark",
    colors: { accent: "#22d3ee", background: "#001122" },
    ...extra,
  };
}

function file(customThemes: unknown[], themeOverrides: unknown = {}) {
  return JSON.stringify({ version: 1, customThemes, themeOverrides });
}

const empty = { customThemes: [] as CustomTheme[], themeOverrides: {} };

test("import rejects malformed JSON", () => {
  assert.throws(() => importThemes("{not json", empty), /not valid JSON/);
  assert.throws(() => importThemes("[]", empty), /does not contain a Jump theme export/);
  assert.throws(() => importThemes("\"hello\"", empty), /does not contain a Jump theme export/);
  assert.throws(() => importThemes("null", empty), /does not contain a Jump theme export/);
});

test("import rejects an unsupported version", () => {
  assert.throws(() => importThemes(JSON.stringify({ version: 9, customThemes: [] }), empty), /Unsupported theme file version/);
});

test("import accepts the exported file shape", () => {
  const exported = buildThemesFile([
    { id: "custom-a1b2c3", name: "Ocean", base: "nord", scheme: "dark", colors: { accent: "#22d3ee" } },
  ], { nord: { background: "#000000" } });
  const result = importThemes(JSON.stringify(exported), empty);
  assert.equal(result.importedCount, 1);
  assert.deepEqual(result.customThemes[0], {
    id: "custom-a1b2c3",
    name: "Ocean",
    base: "nord",
    scheme: "dark",
    colors: { accent: "#22d3ee" },
  });
  assert.deepEqual(result.themeOverrides, { nord: { background: "#000000" } });
});

test("import drops invalid hex colours and unknown tokens", () => {
  const result = importThemes(file([theme("custom-hex0001", "Hex", {
    colors: {
      accent: "blue",
      background: "#AABBCC",
      text: "#12345",
      textSecondary: "#1234567",
      border: "#gggggg",
      selectedRow: "rgb(0, 0, 0)",
      selectedRowText: "#AbCdEf",
      madeUp: "#ffffff",
    },
  })]), empty);
  assert.deepEqual(result.customThemes[0].colors, {
    background: "#aabbcc",
    selectedRowText: "#abcdef",
  });
});

test("import trims and caps theme names", () => {
  const result = importThemes(file([
    theme("custom-long0001", `   ${"A very long theme name ".repeat(4)}   `),
    theme("custom-empty001", "   "),
    theme("custom-badbase01", "Bad base", { base: "nope" }),
    theme("custom-badscheme", "Bad scheme", { scheme: "sepia" }),
  ]), empty);
  assert.equal(result.importedCount, 1);
  assert.equal(result.customThemes[0].name.length, 40);
  assert.equal(result.customThemes[0].name, "A very long theme name A very long theme");
});

test("import keeps at most ten themes in total", () => {
  const eleven = Array.from({ length: 11 }, (_, index) => theme(`custom-many${String(index).padStart(4, "0")}`, `Theme ${index}`));
  const result = importThemes(file(eleven), empty);
  assert.equal(MAX_CUSTOM_THEMES, 10);
  assert.equal(result.customThemes.length, 10);
  assert.equal(result.importedCount, 10);

  const existing: CustomTheme[] = Array.from({ length: 9 }, (_, index) => ({
    id: `custom-have${String(index).padStart(4, "0")}`,
    name: `Have ${index}`,
    base: "nord",
    scheme: "dark",
    colors: {},
  }));
  const merged = importThemes(file([theme("custom-more0001", "One"), theme("custom-more0002", "Two")]), {
    customThemes: existing,
    themeOverrides: {},
  });
  assert.equal(merged.customThemes.length, 10);
  assert.equal(merged.importedCount, 1);
});

test("import regenerates ids on collision and folds their overrides into the renamed theme", () => {
  const existing: CustomTheme[] = [{
    id: "custom-dup00001",
    name: "Existing",
    base: "nord",
    scheme: "dark",
    colors: {},
  }];
  const result = importThemes(file(
    [theme("custom-dup00001", "Imported")],
    { "custom-dup00001": { accent: "#ff0000" } },
  ), { customThemes: existing, themeOverrides: {} });
  const imported = result.customThemes[1];
  assert.equal(result.importedCount, 1);
  assert.notEqual(imported.id, "custom-dup00001");
  assert.match(imported.id, /^custom-[a-z0-9]+$/);
  assert.equal(imported.name, "Imported");
  assert.equal(imported.colors.accent, "#ff0000");
  assert.deepEqual(result.customThemes[0].colors, {});
  assert.deepEqual(result.themeOverrides, {});
});

test("import drops unknown top-level keys and non-object entries", () => {
  const result = importThemes(JSON.stringify({
    version: 1,
    customThemes: [theme("custom-keep0001", "Keep"), "garbage", null, 42],
    themeOverrides: { "custom-keep0001": { accent: "#00ff00" }, bogus: { accent: "#000000" }, nord: { accent: "red" } },
    somethingElse: { nested: true },
  }), empty);
  assert.equal(result.importedCount, 1);
  assert.deepEqual(result.customThemes[0], {
    id: "custom-keep0001",
    name: "Keep",
    base: "nord",
    scheme: "dark",
    colors: { accent: "#00ff00", background: "#001122" },
  });
  assert.deepEqual(result.themeOverrides, {});
});

test("import generates an id for entries without one", () => {
  const result = importThemes(file([{
    name: "No id",
    base: "vesper",
    scheme: "dark",
    colors: { accent: "#ff0000" },
  }]), empty);
  assert.equal(result.importedCount, 1);
  assert.match(result.customThemes[0].id, /^custom-[a-z0-9]+$/);
});

test("import rejects a file with nothing usable", () => {
  assert.throws(() => importThemes(JSON.stringify({ version: 1, customThemes: [] }), empty), /no usable themes/);
  assert.throws(() => importThemes(JSON.stringify({ version: 1, customThemes: [{ name: "" }] }), empty), /no usable themes/);
});

test("stored theme arrays and overrides are sanitised", () => {
  assert.deepEqual(parseCustomThemes("nope"), []);
  assert.deepEqual(parseThemeOverrides(null), {});
  assert.deepEqual(parseThemeOverrides({ nord: { accent: "#FFFFFF" }, bad: { accent: "#ffffff" } }), {
    nord: { accent: "#ffffff" },
  });
});

test("import folds overrides for custom ids into the theme and drops unknown custom ids", () => {
  const file = JSON.stringify({
    version: 1,
    customThemes: [{ id: "custom-abc", name: "Ocean", base: "default", scheme: "dark", colors: { accent: "#111111" } }],
    themeOverrides: {
      "custom-abc": { accent: "#222222" },
      "custom-ghost": { accent: "#333333" },
      nord: { text: "#eeeeee" },
    },
  });
  const result = importThemes(file, { customThemes: [], themeOverrides: {} });
  assert.equal(result.customThemes[0].colors.accent, "#222222");
  assert.deepEqual(Object.keys(result.themeOverrides), ["nord"]);
});
