// xml.test.mjs — node:test suite for xml.mjs (hand-written XML parser + serializer).
//
// This module is the FOUNDATION of the whole phase-B XML pipeline (schema.mjs, changelog.mjs,
// the validator), so the suite is deliberately adversarial. Three properties matter most:
//   1. FIXED POINT — serialize(parse(x)) converges: serializing twice changes nothing.
//   2. NEVER SILENTLY ACCEPT GARBAGE — malformed input throws, with a real line:column. A
//      permissive parser is the widest blast radius in this plan (plan.md Failure Modes): the
//      schema would then "validate" garbage and the changelog would assert untrue things.
//   3. THE ESCAPE SETS DIFFER — text and attribute contexts have different requirements.
// Plus the 300-line budget on xml.mjs itself (plan.md Pre-Mortem #2), asserted mechanically.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, serialize, escapeText, escapeAttr, lineCol } from "./xml.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Serialize twice; both results must agree (that IS the fixed-point property). */
function roundTrip(xml) {
  const once = serialize(parse(xml));
  const twice = serialize(parse(once));
  assert.equal(twice, once, "serialize(parse(x)) is not a fixed point");
  return once;
}

/** Assert `xml` throws a parse error matching `re`, carrying line/column. */
function assertThrowsAt(xml, re, line, column) {
  let caught = null;
  try {
    parse(xml);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `expected a parse error for ${JSON.stringify(xml)}, got none`);
  assert.match(caught.message, re);
  assert.match(caught.message, /\(line \d+, column \d+\)$/, "error message must end with line/column");
  if (line !== undefined) assert.equal(caught.line, line, `line for ${JSON.stringify(xml)}`);
  if (column !== undefined) assert.equal(caught.column, column, `column for ${JSON.stringify(xml)}`);
}

describe("xml.mjs — round-trip fixed point", () => {
  const fixtures = {
    "minimal doc": "<a/>",
    "empty element with explicit close": "<a></a>",
    "nested elements": "<a><b><c/></b></a>",
    attributes: '<a x="1" y="two"/>',
    "self-closing among siblings": "<a><b/><c/><b/></a>",
    cdata: "<a><![CDATA[raw <not> &markup;]]></a>",
    comment: "<a><!-- a note --></a>",
    "xml declaration": '<?xml version="1.0" encoding="UTF-8"?><a/>',
    "declaration + standalone": '<?xml version="1.0" standalone="yes"?><a/>',
    "mixed text and elements": "<a>before<b/>after</a>",
    "prolog comment before root": "<!-- header --><a/>",
    "trailing comment after root": "<a/><!-- footer -->",
    "whitespace between elements": "<a>\n  <b/>\n</a>\n",
    "unicode text": "<a>arrow → done</a>",
    "unicode in attribute": '<a note="a → b"/>',
    "deeply nested": `${"<n>".repeat(200)}x${"</n>".repeat(200)}`,
    "text that looks like a tag (escaped)": "<a>&lt;b&gt;not markup&lt;/b&gt;</a>",
    "]]> inside text": "<a>x]]>y</a>",
    "comment containing double dash": "<a><!-- a -- b --></a>",
    "attribute value containing a literal >": '<a expr="x>y"/>',
    "everything at once": '<?xml version="1.0"?><!--c--><r id="1"><a x="&amp;"/>t<![CDATA[z]]><!--k--></r>',
  };
  for (const [name, xml] of Object.entries(fixtures)) {
    it(`is a fixed point: ${name}`, () => roundTrip(xml));
  }

  it("canonicalizes <a></a> to <a/> and then holds still", () => {
    assert.equal(roundTrip("<a></a>"), "<a/>");
  });

  it("preserves whitespace-only text nodes byte-for-byte", () => {
    const doc = parse("<a>  <b/>\t\n</a>");
    const kinds = doc.children[0].children.map((n) => n.type);
    assert.deepEqual(kinds, ["text", "element", "text"]);
    assert.equal(doc.children[0].children[0].value, "  ");
    assert.equal(doc.children[0].children[2].value, "\t\n");
    assert.equal(serialize(doc), "<a>  <b/>\t\n</a>");
  });

  it("preserves attribute order", () => {
    assert.equal(roundTrip('<a z="1" m="2" a="3"/>'), '<a z="1" m="2" a="3"/>');
  });

  it("returns the documented DOM shape", () => {
    const doc = parse('<r id="1">hi</r>');
    assert.equal(doc.type, "document");
    const root = doc.children[0];
    assert.equal(root.type, "element");
    assert.equal(root.name, "r");
    assert.deepEqual(root.attrs, { id: "1" });
    assert.deepEqual(root.children, [{ type: "text", value: "hi" }]);
  });

  it("serializes a bare {name, attrs, children} node (no type) as an element", () => {
    assert.equal(serialize({ name: "a", attrs: { x: "1" }, children: [] }), '<a x="1"/>');
  });
});

describe("xml.mjs — entities and character references", () => {
  it("decodes all 5 predefined entities in text", () => {
    const root = parse("<a>&lt;&gt;&amp;&quot;&apos;</a>").children[0];
    assert.equal(root.children[0].value, `<>&"'`);
  });

  it("decodes all 5 predefined entities in an attribute value", () => {
    const root = parse(`<a v="&lt;&gt;&amp;&quot;&apos;"/>`).children[0];
    assert.equal(root.attrs.v, `<>&"'`);
  });

  it("decodes decimal character references", () => {
    assert.equal(parse("<a>&#65;&#8594;</a>").children[0].children[0].value, "A→");
  });

  it("decodes hex character references (both &#x and &#X)", () => {
    assert.equal(parse("<a>&#x41;&#X2192;</a>").children[0].children[0].value, "A→");
  });

  it("decodes character references inside attribute values", () => {
    assert.equal(parse('<a v="&#8594;"/>').children[0].attrs.v, "→");
  });

  it("round-trips a decoded numeric ref as its literal character (not byte-identical, but fixed)", () => {
    assert.equal(roundTrip("<a>&#65;</a>"), "<a>A</a>");
  });

  it("rejects an unknown entity — there is no DTD", () => {
    assertThrowsAt("<a>&nbsp;</a>", /unknown entity "&nbsp;"/);
  });

  it("rejects a bare & in text", () => {
    assertThrowsAt("<a>a & b</a>", /malformed entity reference/);
  });

  it("rejects a bare & in an attribute value", () => {
    assertThrowsAt('<a v="a & b"/>', /malformed entity reference/);
  });

  it("rejects a malformed character reference", () => {
    assertThrowsAt("<a>&#zz;</a>", /malformed character reference/);
  });

  it("rejects an out-of-range character reference", () => {
    assertThrowsAt("<a>&#0;</a>", /out of range/);
    assertThrowsAt("<a>&#x110000;</a>", /out of range/);
  });
});

describe("xml.mjs — escaping (the two contexts differ)", () => {
  it("escapeText escapes &, < and > — and > unconditionally, which is what makes ]]> safe", () => {
    assert.equal(escapeText(`a&b<c>d]]>e`), "a&amp;b&lt;c&gt;d]]&gt;e");
  });

  it('escapeText does NOT escape quotes (they are legal in text)', () => {
    assert.equal(escapeText(`he said "hi" it's fine`), `he said "hi" it's fine`);
  });

  it("escapeAttr escapes &, <, >, double quote AND single quote", () => {
    assert.equal(escapeAttr(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  it("escapeAttr turns newline/CR/tab into numeric refs (a conformant reader would eat them)", () => {
    assert.equal(escapeAttr("a\nb\rc\td"), "a&#10;b&#13;c&#9;d");
  });

  it("an attribute value with a newline survives the round trip intact", () => {
    const xml = serialize({ name: "a", attrs: { reason: "fix race: x\ny" }, children: [] });
    assert.equal(xml, '<a reason="fix race: x&#10;y"/>');
    assert.equal(parse(xml).children[0].attrs.reason, "fix race: x\ny");
  });

  it("every escape-sensitive char survives a text round trip", () => {
    const value = `& < > " ' ]]> → 🙂`;
    const xml = serialize({ name: "a", attrs: {}, children: [{ type: "text", value }] });
    assert.equal(parse(xml).children[0].children[0].value, value);
    assert.equal(serialize(parse(xml)), xml);
  });

  it("every escape-sensitive char survives an attribute round trip", () => {
    const value = `& < > " ' → pipe|s`;
    const xml = serialize({ name: "a", attrs: { v: value }, children: [] });
    assert.equal(parse(xml).children[0].attrs.v, value);
    assert.equal(serialize(parse(xml)), xml);
  });

  it("CDATA containing ]]> is split across two sections and still round-trips", () => {
    const xml = serialize({ name: "a", attrs: {}, children: [{ type: "cdata", value: "x]]>y" }] });
    assert.equal(xml, "<a><![CDATA[x]]]]><![CDATA[>y]]></a>");
    const kids = parse(xml).children[0].children;
    assert.deepEqual(kids.map((k) => k.type), ["cdata", "cdata"]);
    assert.equal(kids.map((k) => k.value).join(""), "x]]>y", "concatenated CDATA must equal the original");
    assert.equal(serialize(parse(xml)), xml, "the split form is a fixed point");
  });

  it("CDATA content is never entity-decoded", () => {
    assert.equal(parse("<a><![CDATA[&amp; &#65; <b>]]></a>").children[0].children[0].value, "&amp; &#65; <b>");
  });
});

describe("xml.mjs — malformed input throws with line:column", () => {
  it("empty input", () => assertThrowsAt("", /empty document: no root element/, 1, 1));
  it("whitespace-only input", () => assertThrowsAt("   \n  ", /empty document: no root element/));
  it("unclosed tag", () => assertThrowsAt("<a><b></a>", /mismatched closing tag <\/a> for <b>/, 1, 7));
  it("unclosed root at EOF", () => assertThrowsAt("<a><b/>", /unclosed element <a>/, 1, 1));
  it("unclosed start tag at EOF", () => assertThrowsAt("<a", /unclosed <a> tag/, 1, 1));
  it("mismatched close tag", () => assertThrowsAt("<a></b>", /mismatched closing tag <\/b> for <a>/, 1, 4));
  it("stray < in text", () => assertThrowsAt("<a>1 < 2</a>", /stray "<"/, 1, 6));
  it("stray < before EOF", () => assertThrowsAt("<a>x<", /stray "<"/));
  it("unquoted attribute value", () => assertThrowsAt("<a b=1/>", /value of attribute "b" must be quoted/, 1, 6));
  it("missing = after attribute name", () => assertThrowsAt('<a b "1"/>', /expected "=" after attribute "b"/));
  it("unterminated attribute value", () => assertThrowsAt('<a b="1/>', /unterminated value for attribute "b"/));
  it("duplicate attribute", () => assertThrowsAt('<a b="1" b="2"/>', /duplicate attribute "b" in <a>/, 1, 10));
  it("missing whitespace between attributes", () => assertThrowsAt('<a b="1"c="2"/>', /expected whitespace before the next attribute/));
  it("raw < inside an attribute value", () => assertThrowsAt('<a b="x<y"/>', /raw "<" in value of attribute "b"/));
  it("unterminated CDATA", () => assertThrowsAt("<a><![CDATA[x</a>", /unterminated CDATA section/, 1, 4));
  it("unterminated comment", () => assertThrowsAt("<a><!-- x</a>", /unterminated comment/, 1, 4));
  it("junk after root (second element)", () => assertThrowsAt("<a/><b/>", /junk after the root element/, 1, 5));
  it("junk after root (text)", () => assertThrowsAt("<a/>junk", /text is not allowed outside the root element/, 1, 5));
  it("text before root", () => assertThrowsAt("junk<a/>", /text is not allowed outside the root element/, 1, 1));
  it("two roots separated by a comment", () => assertThrowsAt("<a/><!--c--><b/>", /junk after the root element/));
  it("stray closing tag at top level", () => assertThrowsAt("</a>", /stray "<"/, 1, 1));
  it("CDATA outside the root", () => assertThrowsAt("<![CDATA[x]]><a/>", /CDATA is not allowed outside the root element/, 1, 1));
  it("element name may not start with a digit", () => assertThrowsAt("<1a/>", /stray "<"/));
  it("declaration not first", () => assertThrowsAt('<a/><?xml version="1.0"?>', /XML declaration must be the first thing/));
  it("unknown declaration attribute", () => assertThrowsAt('<?xml foo="1"?><a/>', /unknown XML-declaration attribute "foo"/));

  it("reports the correct line and column on a multi-line document", () => {
    assertThrowsAt('<r>\n  <a/>\n  <b>\n    <c/>\n  </d>\n</r>', /mismatched closing tag <\/d> for <b>/, 5, 3);
  });

  it("parse() rejects a non-string input", () => {
    assert.throws(() => parse(null), TypeError);
    assert.throws(() => parse(42), TypeError);
  });
});

describe("xml.mjs — the restricted subset fails LOUDLY (D-001)", () => {
  // These are not "unsupported and ignored" — they are hard errors. If a real requirement ever
  // forces one of these to be SUPPORTED, that is Pre-Mortem trigger #2: re-open D-001 rather
  // than growing this parser.
  it("rejects a DOCTYPE / DTD", () => {
    assertThrowsAt('<!DOCTYPE a SYSTEM "a.dtd"><a/>', /DTD \/ doctype declarations are not supported/);
  });
  it("rejects an internal entity declaration", () => {
    assertThrowsAt("<!ENTITY foo 'bar'><a/>", /DTD \/ doctype declarations are not supported/);
  });
  it("rejects a processing instruction", () => {
    assertThrowsAt("<a><?php echo 1; ?></a>", /processing instructions are not supported/);
  });
  it("rejects a namespaced element name (no namespace support)", () => {
    assert.throws(() => parse('<ns:a/>'), /XML parse error/);
  });
  it("rejects a namespaced attribute name", () => {
    assert.throws(() => parse('<a xmlns:ns="u" ns:x="1"/>'), /XML parse error/);
  });
});

describe("xml.mjs — serialize guards", () => {
  it("throws on an invalid element name", () => {
    assert.throws(() => serialize({ type: "element", name: "1bad", attrs: {}, children: [] }), /invalid element name/);
    assert.throws(() => serialize({ type: "element", name: "ns:a", attrs: {}, children: [] }), /invalid element name/);
  });
  it("throws on an invalid attribute name", () => {
    assert.throws(() => serialize({ name: "a", attrs: { "bad name": "1" }, children: [] }), /invalid attribute name/);
  });
  it('throws on a comment containing "-->"', () => {
    assert.throws(() => serialize({ type: "comment", value: "a --> b" }), /may not contain "-->"/);
  });
  it("throws on an unknown node type", () => {
    assert.throws(() => serialize({ type: "bogus" }), TypeError);
  });
  it("throws on a non-object", () => {
    assert.throws(() => serialize(null), TypeError);
    assert.throws(() => serialize("<a/>"), TypeError);
  });
  it("skips null/undefined attribute values rather than emitting \"null\"", () => {
    assert.equal(serialize({ name: "a", attrs: { x: null, y: undefined, z: "1" }, children: [] }), '<a z="1"/>');
  });
  it("serializes numeric attribute values by stringifying them", () => {
    assert.equal(serialize({ name: "a", attrs: { n: 42 }, children: [] }), '<a n="42"/>');
  });
});

describe("xml.mjs — lineCol", () => {
  it("is 1-based at the start", () => assert.deepEqual(lineCol("abc", 0), { line: 1, column: 1 }));
  it("counts columns within a line", () => assert.deepEqual(lineCol("abc", 2), { line: 1, column: 3 }));
  it("resets the column after a newline", () => assert.deepEqual(lineCol("ab\ncd", 3), { line: 2, column: 1 }));
  it("counts multiple lines", () => assert.deepEqual(lineCol("a\nb\nc", 4), { line: 3, column: 1 }));
});

describe("xml.mjs — complexity budget (plan.md Pre-Mortem trigger #2)", () => {
  it("xml.mjs is at most 300 lines — exceeding this re-opens D-001, it does not license a bigger parser", () => {
    const source = readFileSync(join(HERE, "xml.mjs"), "utf8");
    const lines = (source.match(/\n/g) ?? []).length; // matches `wc -l`
    assert.ok(lines <= 300, `xml.mjs is ${lines} lines, over the 300-line hard budget (Pre-Mortem #2: STOP and re-open D-001)`);
  });
});
