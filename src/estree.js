// ─── estree: ESTree JSON → JavaScript source ────────────────────
//
// debashl emits standard ESTree (PLAN.md §1.2) with shell semantics
// lowered to calls into the `sh2.*` runtime. This emitter renders that
// tree back to JS source, which the shell then runs with the `sh2`
// runtime in scope. The node set debashl emits is small and regular:
//
//   Program, ExpressionStatement, BlockStatement, IfStatement,
//   SwitchStatement, SwitchCase, BreakStatement, LogicalExpression,
//   CallExpression, MemberExpression, Identifier, Literal,
//   ArrayExpression, ObjectExpression, Property, AwaitExpression,
//   ArrowFunctionExpression, TemplateLiteral, TemplateElement
// -----------------------------------------------------------------

export function estreeToJs(program) {
  return program.body.map(statement).join("\n");
}

function statement(n) {
  switch (n.type) {
    case "ExpressionStatement":
      return expression(n.expression) + ";";
    case "BlockStatement":
      return block(n);
    case "IfStatement":
      return `if (${expression(n.test)}) ${statement(n.consequent)}` +
        (n.alternate ? ` else ${statement(n.alternate)}` : "");
    case "SwitchStatement":
      return `switch (${expression(n.discriminant)}) {\n` +
        n.cases.map(switchCase).join("") + "}";
    case "BreakStatement":
      return "break;";
    case "ReturnStatement":
      return `return ${n.argument ? expression(n.argument) : ""};`;
    case "VariableDeclaration":
      return `${n.kind || "let"} ${n.declarations
        .map((d) => `${d.id.name}${d.init ? " = " + expression(d.init) : ""}`)
        .join(", ")};`;
    case "FunctionDeclaration":
      return `function ${n.id.name}(${(n.params || []).map((p) => p.name).join(", ")}) ${block(n.body)}`;
    case "WhileStatement":
      return `while (${expression(n.test)}) ${statement(n.body)}`;
    case "EmptyStatement":
      return "";
    default:
      throw new Error(`estree: unsupported statement ${n.type}`);
  }
}

function block(n) {
  const body = (n.body || []).map(statement).join("\n");
  return `{\n${body}\n}`;
}

function switchCase(n) {
  const label = n.test ? `case ${expression(n.test)}:` : "default:";
  const body = n.consequent.map(statement).join("\n");
  return `  ${label}\n${body}\n`;
}

function expression(n) {
  switch (n.type) {
    case "Identifier":
      return n.name;
    case "Literal":
      return JSON.stringify(n.value);  // arrays as literal values stringify fine
    case "TemplateLiteral":
      return template(n);
    case "MemberExpression":
      return expression(n.object) + (n.computed
        ? `[${expression(n.property)}]`
        : `.${expression(n.property)}`);
    case "CallExpression":
      return expression(n.callee) + "(" + n.arguments.map(expression).join(", ") + ")";
    case "AwaitExpression":
      return `await ${expression(n.argument)}`;
    case "LogicalExpression":
      // Always parenthesized — sidesteps &&/|| precedence entirely.
      return `(${expression(n.left)} ${n.operator} ${expression(n.right)})`;
    case "UnaryExpression":
      return n.operator + expression(n.argument);
    case "ArrayExpression":
      return "[" + (n.elements || []).map(expression).join(", ") + "]";
    case "ObjectExpression":
      return "{" + n.properties.map(prop).join(", ") + "}";
    case "ArrowFunctionExpression":
      return arrow(n);
    default:
      throw new Error(`estree: unsupported expression ${n.type}`);
  }
}

function prop(n) {
  const key = n.key.type === "Identifier" ? n.key.name : JSON.stringify(n.key.value);
  return `${key}: ${expression(n.value)}`;
}

function arrow(n) {
  const params = (n.params || []).map((p) => p.name).join(", ");
  if (n.expression) {
    const body = expression(n.body);
    // AwaitExpression at the top of an expression arrow body would be a
    // syntax error without parens when it starts with an object literal —
    // not the case here, but keep it simple and safe:
    return `${n.async ? "async " : ""}(${params}) => ${body}`;
  }
  return `${n.async ? "async " : ""}(${params}) => ${block(n.body)}`;
}

function template(n) {
  const quasis = n.quasis;
  const exprs = n.expressions || [];
  let out = "`";
  for (let i = 0; i < quasis.length; i++) {
    const cooked = quasis[i].value.cooked != null ? quasis[i].value.cooked : quasis[i].value.raw;
    // Escape so the emitted template literal means what the shell meant.
    out += String(cooked)
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");
    if (i < exprs.length) out += "${" + expression(exprs[i]) + "}";
  }
  return out + "`";
}
