// ─── __native-arrays-key-test.mjs — nativeArrays must NOT fold an array
// whose arrayIndex key is a "$x" string literal NESTED inside a setVar.
//
// The wasm emits store-backed reads as
//   sh2.setVar("rd_cs", sh2.arrayIndex("SCOS", "$rd_deg"))
// The nativeArrays eligibility walk handled the setVar NAME but returned
// before descending into the VALUE — so the nested arrayIndex's "$rd_deg"
// string key was never seen, SCOS stayed "eligible", and the rewrite walk
// folded it to (SCOS || [])[Number("$rd_deg")] = NaN → rd_cs = "" → every
// block culled (invisible world). The eligibility walk must descend into
// setVar values so the "$x" key marks the array bad and it stays store-backed.
import { nativeArrays } from "./src/lower.js";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

const lit = (v) => ({ type: "Literal", value: v });
const id = (n) => ({ type: "Identifier", name: n });
const sh2 = (fn, args) => ({
  type: "CallExpression",
  callee: { type: "MemberExpression", object: id("sh2"), property: id(fn), computed: false, optional: false },
  arguments: args,
});

// 1) the nested "$x" key case: the bug (must stay arrayIndex)
{
  const program = {
    type: "Program",
    body: [
      { type: "ExpressionStatement", expression: sh2("setArray", [lit("SCOS"), { type: "ArrayExpression", elements: [] }]) },
      { type: "ExpressionStatement", expression: sh2("setVar", [lit("rd_cs"), sh2("arrayIndex", [lit("SCOS"), lit("$rd_deg")])]) },
    ],
  };
  const out = nativeArrays(program);
  const j = JSON.stringify(out.body);
  check("nested $x key keeps arrayIndex (store-backed)",
    j.includes('"arrayIndex"') && !j.includes('Number("$rd_deg")'),
    j.slice(0, 120));
}

// 2) the plain literal-key case (must still fold — unchanged behavior)
{
  const program = {
    type: "Program",
    body: [
      { type: "ExpressionStatement", expression: sh2("setArray", [lit("A"), { type: "ArrayExpression", elements: [lit("1")] }]) },
      { type: "ExpressionStatement", expression: sh2("setVar", [lit("x"), sh2("arrayIndex", [lit("A"), lit("2")])]) },
    ],
  };
  const out = nativeArrays(program);
  const j = JSON.stringify(out.body);
  check("plain literal key still folds native",
    j.includes('Number') && j.includes('"2"') && !j.includes('arrayIndex'),
    j.slice(0, 160));
}

if (fails) { console.log(`\nNATIVE-ARRAYS-KEY CHECKS FAILED: ${fails}`); process.exit(1); }
console.log("\nALL NATIVE-ARRAYS-KEY CHECKS PASSED");
