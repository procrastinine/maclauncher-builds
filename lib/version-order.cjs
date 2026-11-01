// Semantic ordering can be declared separately from an immutable package label.
function semanticVersion(value) {
  return typeof value === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value);
}
function declaredVersion(value, declarations = {}) {
  const label = typeof value === "string" ? value : value.version;
  return (typeof value === "object" ? value.semanticVersion : undefined) || (Object.hasOwn(declarations, label) ? declarations[label] : label);
}
function compareRuntimeVersions(left, right, declarations = {}) {
  left = declaredVersion(left, declarations); right = declaredVersion(right, declarations);
  const sourceID = /^(?=[a-f0-9]*[a-f])[a-f0-9]{7,}(?:[-_]|$)/i;
  if (sourceID.test(String(left)) || sourceID.test(String(right))) return 0;
  const stem = value => String(value).replace(/[-_][a-f0-9]{7,}(?:[-_].*)?$/i, "");
  const a = stem(left), b = stem(right);
  if (a === b) return 0;
  const release = /^(\d+(?:\.\d+)+)(?:-(.+))?$/;
  const aa = release.exec(a), bb = release.exec(b);
  if (aa && bb && aa[1] === bb[1] && Boolean(aa[2]) !== Boolean(bb[2])) return aa[2] ? 1 : -1;
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}
function versionSemantics(value = {}, labels) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([label, version]) =>
      !label || !semanticVersion(version) || labels && !labels.has(label))) throw Error("Invalid declared semantic versions.");
  return Object.freeze({ ...value });
}
module.exports = { semanticVersion, declaredVersion, compareRuntimeVersions, versionSemantics };
