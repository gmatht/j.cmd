// fortune v1 — print a random quotation (like the classic fortune)
//
// NAME
//      fortune — print a random quotation
//
// SYNOPSIS
//      fortune [-s]
//
// DESCRIPTION
//      fortune prints a random quote, proverb or joke from its built-in
//      collection. -s (short) picks from the one-liners only.
//
// OPTIONS
//      -s, --short   only short quotes
//      -h, --help    show this help
//
// EXAMPLES
//      fortune
//      cowsay "$(fortune -s)"

var SHORT = [
  "There is no place like 127.0.0.1.",
  "A journey of a thousand miles begins with a single compile error.",
  "Git: because every bug deserves a commit message.",
  "The best way to predict the future is to implement it.",
  "sudo rm -rf is a lifestyle choice, not a command.",
  "Perl: write once, read never.",
  "The cloud is just someone else's computer.",
  "I have not failed. I have just found 10,000 ways that do not work.",
  "Weeks of coding can save you hours of planning.",
  "It works on my machine.",
  "A bug is never just a mistake. It represents something bigger.",
  "Do or do not. There is no try-catch.",
  "Real programmers count from zero.",
  "The code compiles, therefore it is correct.",
  "git push --force is the nuclear option.",
  "Simplicity is the ultimate sophistication.",
];
var LONG = [
  "Two bytes meet. The first byte asks: are you ill? The second says: no, just a bit off by one.",
  "A SQL query walks into a bar, goes up to two tables and asks: can I join you?",
  "There are only two hard things in computer science: cache invalidation, naming things, and off-by-one errors.",
  "A programmer is a machine that turns coffee into code. An admin is a machine that turns coffee into uptime.",
  "Knock knock. Who's there? Interrupting cow. Interrupting cow wh-- MOO! (press Ctrl+C to continue)",
  "The three virtues of a programmer: laziness, impatience, and hubris. Plus good backups.",
  "An optimist says the glass is half full. A pessimist says it is half empty. An engineer says it is twice as big as it needs to be.",
  "In theory there is no difference between theory and practice. In practice there is.",
];

function usage() {
  console.log("fortune — print a random quotation");
  console.log("usage: fortune [-s]");
  console.log("  -s, --short   only short one-liners");
}

if (args[0] === "-h" || args[0] === "--help") { usage(); return 0; }
var pool = (args[0] === "-s" || args[0] === "--short") ? SHORT : SHORT.concat(LONG);
var pick = pool[Math.floor(Math.random() * pool.length)];
console.log(pick);
console.log("        -- from /usr/share/fortune (built-in)");
return 0;
