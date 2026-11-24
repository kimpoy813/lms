// Curated built-in programming problem templates with verified multi-language starter code
// and exact sample/hidden stdin-stdout test cases for Discenda's zero-key AI mode.

const STARTER_BOILERPLATE = {
  PYTHON: 'import sys\n\ndef main():\n    data = sys.stdin.read().strip().split()\n    if not data:\n        return\n    # TODO: compute and print the result\n\nif __name__ == "__main__":\n    main()\n',
  JAVASCRIPT: 'const fs = require("fs");\nconst tokens = fs.readFileSync(0, "utf8").trim().split(/\\s+/).filter(Boolean);\nif (tokens.length === 0) process.exit(0);\n// TODO: compute and print the result\n',
  C: '#include <stdio.h>\n\nint main(void) {\n    // TODO: read from stdin and print the result\n    return 0;\n}\n',
  CPP: '#include <iostream>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    // TODO: read from stdin and print the result\n    return 0;\n}\n',
  JAVA: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        // TODO: read from stdin and print the result\n    }\n}\n',
};

const escHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cleanLine = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const PROGRAMMING_TEMPLATES = [
  {
    id: 'array-sum-average',
    keywords: ['sum', 'average', 'mean', 'total', 'array sum', 'list sum', 'accumulate'],
    difficulty: 'EASY',
    title: 'Sum and Integer Average of a List',
    statementHtml: [
      '<p>Given an integer <code>n</code> followed by <code>n</code> integers, print two space-separated integers: their <strong>sum</strong> and their <strong>integer-truncated average</strong> (<code>floor(sum / n)</code> for non-negative sums, or standard integer division toward zero).</p>',
      '<h4>Input format</h4>',
      '<ul><li>Line 1: an integer <code>n</code> (<code>1 &le; n &le; 1000</code>).</li><li>Line 2: <code>n</code> space-separated integers.</li></ul>',
      '<h4>Output format</h4>',
      '<p>Print <code>sum average</code> on a single line.</p>',
    ].join(''),
    starterCode: {
      PYTHON: 'n = int(input())\nnums = list(map(int, input().split()))\ntotal = sum(nums)\n# TODO: print total and truncated integer average\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst t = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconst n = t[0];\nconst nums = t.slice(1, 1 + n);\n// TODO: print sum and integer average\n',
      C: '#include <stdio.h>\nint main(void) {\n    int n, x;\n    long long sum = 0;\n    if (scanf("%d", &n) != 1) return 0;\n    for (int i = 0; i < n; i++) { scanf("%d", &x); sum += x; }\n    // TODO: print sum and sum / n\n    return 0;\n}\n',
      CPP: '#include <iostream>\nusing namespace std;\nint main() {\n    int n; cin >> n;\n    long long sum = 0, x;\n    for (int i = 0; i < n; i++) { cin >> x; sum += x; }\n    // TODO: print sum and sum / n\n    return 0;\n}\n',
      JAVA: 'import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int n = sc.nextInt();\n        long sum = 0;\n        for (int i = 0; i < n; i++) sum += sc.nextLong();\n        // TODO: System.out.println(sum + " " + (sum / n));\n    }\n}\n',
    },
    testCases: [
      { input: '4\n10 20 30 40', expectedOutput: '100 25', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '3\n5 8 9', expectedOutput: '22 7', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '1\n42', expectedOutput: '42 42', isHidden: true, weight: 1, comparison: 'TOKENS' },
      { input: '5\n100 200 300 400 500', expectedOutput: '1500 300', isHidden: true, weight: 2, comparison: 'TOKENS' },
      { input: '4\n0 0 0 3', expectedOutput: '3 0', isHidden: true, weight: 2, comparison: 'TOKENS' },
    ],
  },
  {
    id: 'min-max-range',
    keywords: ['minimum', 'maximum', 'largest', 'smallest', 'min max', 'range', 'extrem'],
    difficulty: 'EASY',
    title: 'Minimum, Maximum, and Range',
    statementHtml: [
      '<p>Read <code>n</code> integers and report the <strong>minimum</strong>, the <strong>maximum</strong>, and the <strong>range</strong> (<code>max - min</code>).</p>',
      '<h4>Input format</h4>',
      '<ul><li>Line 1: integer <code>n</code> (<code>1 &le; n &le; 1000</code>).</li><li>Line 2: <code>n</code> space-separated integers.</li></ul>',
      '<h4>Output format</h4>',
      '<p>Print three integers separated by spaces: <code>min max range</code>.</p>',
    ].join(''),
    starterCode: {
      PYTHON: 'n = int(input())\nnums = list(map(int, input().split()))\n# TODO: compute lo, hi, and hi - lo\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst t = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconst nums = t.slice(1, 1 + t[0]);\n// TODO: print min, max, and range\n',
    },
    testCases: [
      { input: '5\n3 9 1 7 4', expectedOutput: '1 9 8', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '3\n-5 0 5', expectedOutput: '-5 5 10', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '1\n17', expectedOutput: '17 17 0', isHidden: true, weight: 1, comparison: 'TOKENS' },
      { input: '4\n-12 -3 -20 -8', expectedOutput: '-20 -3 17', isHidden: true, weight: 2, comparison: 'TOKENS' },
      { input: '6\n10 10 10 10 10 10', expectedOutput: '10 10 0', isHidden: true, weight: 2, comparison: 'TOKENS' },
    ],
  },
  {
    id: 'even-odd-count',
    keywords: ['even', 'odd', 'parity', 'modulo', 'divisible', 'loop', 'conditional'],
    difficulty: 'EASY',
    title: 'Count Even and Odd Integers',
    statementHtml: [
      '<p>Given <code>n</code> integers, count how many are <strong>even</strong> and how many are <strong>odd</strong>. Remember that <code>0</code> and negative multiples of <code>2</code> are even.</p>',
      '<h4>Input format</h4>',
      '<ul><li>Line 1: <code>n</code> (<code>1 &le; n &le; 1000</code>).</li><li>Line 2: <code>n</code> integers.</li></ul>',
      '<h4>Output format</h4>',
      '<p>Print <code>even_count odd_count</code>.</p>',
    ].join(''),
    starterCode: {
      PYTHON: 'n = int(input())\nnums = list(map(int, input().split()))\n# TODO: count even and odd integers\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst t = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconst nums = t.slice(1, 1 + t[0]);\n// TODO: count even and odd integers\n',
    },
    testCases: [
      { input: '5\n1 2 3 4 5', expectedOutput: '2 3', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '4\n0 -2 -7 8', expectedOutput: '3 1', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '3\n11 13 15', expectedOutput: '0 3', isHidden: true, weight: 1, comparison: 'TOKENS' },
      { input: '6\n2 4 6 8 10 12', expectedOutput: '6 0', isHidden: true, weight: 2, comparison: 'TOKENS' },
      { input: '1\n-1', expectedOutput: '0 1', isHidden: true, weight: 2, comparison: 'TOKENS' },
    ],
  },
  {
    id: 'prime-checker',
    keywords: ['prime', 'composite', 'divisor', 'number theory'],
    difficulty: 'EASY',
    title: 'Prime Number Checker',
    statementHtml: [
      '<p>Determine whether a given integer <code>n</code> is a <strong>prime number</strong>. Print <code>PRIME</code> if it is prime, or <code>NOT PRIME</code> otherwise (note that numbers &le; 1 are not prime).</p>',
      '<h4>Input format</h4><p>A single integer <code>n</code> (<code>0 &le; n &le; 10^9</code>).</p>',
      '<h4>Output format</h4><p><code>PRIME</code> or <code>NOT PRIME</code>.</p>',
    ].join(''),
    starterCode: {
      PYTHON: 'n = int(input().strip())\n# TODO: test divisibility up to sqrt(n)\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst n = Number(fs.readFileSync(0, "utf8").trim());\n// TODO: print PRIME or NOT PRIME\n',
    },
    testCases: [
      { input: '2', expectedOutput: 'PRIME', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '9', expectedOutput: 'NOT PRIME', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '1', expectedOutput: 'NOT PRIME', isHidden: true, weight: 1, comparison: 'TRIMMED' },
      { input: '0', expectedOutput: 'NOT PRIME', isHidden: true, weight: 1, comparison: 'TRIMMED' },
      { input: '97', expectedOutput: 'PRIME', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: '1000000007', expectedOutput: 'PRIME', isHidden: true, weight: 2, comparison: 'TRIMMED' },
    ],
  },
  {
    id: 'factorial-fibonacci',
    keywords: ['fibonacci', 'factorial', 'recursion', 'recursive', 'dp', 'sequence'],
    difficulty: 'MEDIUM',
    title: 'Nth Fibonacci Number',
    statementHtml: [
      '<p>Given an integer <code>n</code> (<code>0 &le; n &le; 40</code>), compute the <code>n</code>-th Fibonacci number where <code>F(0) = 0</code>, <code>F(1) = 1</code>, and <code>F(n) = F(n - 1) + F(n - 2)</code>.</p>',
      '<h4>Note</h4><p>For larger values of <code>n</code>, an iterative loop or memoized recursion avoids exponential time complexity.</p>',
    ].join(''),
    starterCode: {
      PYTHON: 'n = int(input().strip())\n# TODO: compute F(n)\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst n = Number(fs.readFileSync(0, "utf8").trim());\n// TODO: compute F(n)\n',
    },
    testCases: [
      { input: '0', expectedOutput: '0', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '6', expectedOutput: '8', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '1', expectedOutput: '1', isHidden: true, weight: 1, comparison: 'TRIMMED' },
      { input: '10', expectedOutput: '55', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: '30', expectedOutput: '832040', isHidden: true, weight: 2, comparison: 'TRIMMED' },
    ],
  },
  {
    id: 'string-palindrome',
    keywords: ['palindrome', 'string', 'reverse', 'vowel', 'character', 'word'],
    difficulty: 'EASY',
    title: 'Case-Insensitive Palindrome Check',
    statementHtml: [
      '<p>Read a single line of text and check whether its alphanumeric characters form a <strong>palindrome</strong> when letter case and punctuation/spaces are ignored.</p>',
      '<h4>Output format</h4><p>Print <code>YES</code> if it is a palindrome, or <code>NO</code> otherwise.</p>',
    ].join(''),
    starterCode: {
      PYTHON: 's = input().strip()\n# TODO: keep alphanumeric chars, lowercase, and compare with reverse\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst s = fs.readFileSync(0, "utf8").trim();\n// TODO: print YES or NO\n',
    },
    testCases: [
      { input: 'Racecar', expectedOutput: 'YES', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: 'hello', expectedOutput: 'NO', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: 'A man, a plan, a canal: Panama', expectedOutput: 'YES', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: 'No lemon, no melon', expectedOutput: 'YES', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: '123421', expectedOutput: 'NO', isHidden: true, weight: 2, comparison: 'TRIMMED' },
    ],
  },
  {
    id: 'frequency-unique',
    keywords: ['frequency', 'duplicate', 'distinct', 'unique', 'hash', 'dictionary', 'map', 'count occurrence'],
    difficulty: 'MEDIUM',
    title: 'Count Distinct Values and Most Frequent Item',
    statementHtml: [
      '<p>Given <code>n</code> integers, determine: (1) the number of <strong>distinct</strong> integers, and (2) the integer that appears most frequently (if tied, choose the <strong>smallest</strong> such integer).</p>',
      '<h4>Output format</h4><p>Print <code>distinct_count mode_value</code>.</p>',
    ].join(''),
    starterCode: {
      PYTHON: 'n = int(input())\nnums = list(map(int, input().split()))\n# TODO: count frequencies and find distinct count and smallest mode\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst t = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconst nums = t.slice(1, 1 + t[0]);\n// TODO: print distinct_count mode_value\n',
    },
    testCases: [
      { input: '6\n4 2 4 3 2 4', expectedOutput: '3 4', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '4\n5 2 5 2', expectedOutput: '2 2', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '1\n9', expectedOutput: '1 9', isHidden: true, weight: 1, comparison: 'TOKENS' },
      { input: '5\n1 2 3 4 5', expectedOutput: '5 1', isHidden: true, weight: 2, comparison: 'TOKENS' },
      { input: '7\n-1 -1 0 0 0 2 2', expectedOutput: '3 0', isHidden: true, weight: 2, comparison: 'TOKENS' },
    ],
  },
  {
    id: 'sorting-median',
    keywords: ['sort', 'bubble', 'selection', 'insertion', 'merge', 'quicksort', 'ascending', 'median'],
    difficulty: 'MEDIUM',
    title: 'Sort Numbers in Ascending Order',
    statementHtml: [
      '<p>Given <code>n</code> integers, sort them in non-decreasing (ascending) order and print them on one line separated by single spaces.</p>',
      '<h4>Input format</h4><ul><li>Line 1: <code>n</code> (<code>1 &le; n &le; 1000</code>).</li><li>Line 2: <code>n</code> integers.</li></ul>',
    ].join(''),
    starterCode: {
      PYTHON: 'n = int(input())\nnums = list(map(int, input().split()))\n# TODO: sort nums and print space-separated values\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst t = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconst nums = t.slice(1, 1 + t[0]);\n// TODO: sort nums numerically ascending\n',
    },
    testCases: [
      { input: '5\n5 1 4 2 8', expectedOutput: '1 2 4 5 8', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '4\n3 -1 0 -1', expectedOutput: '-1 -1 0 3', isHidden: false, weight: 1, comparison: 'TOKENS' },
      { input: '1\n99', expectedOutput: '99', isHidden: true, weight: 1, comparison: 'TOKENS' },
      { input: '6\n10 9 8 7 6 5', expectedOutput: '5 6 7 8 9 10', isHidden: true, weight: 2, comparison: 'TOKENS' },
    ],
  },
  {
    id: 'binary-search',
    keywords: ['binary search', 'linear search', 'search', 'target', 'index', 'lookup'],
    difficulty: 'MEDIUM',
    title: 'Binary Search in a Sorted Array',
    statementHtml: [
      '<p>Given a sorted ascending list of <code>n</code> distinct integers and a target value <code>target</code>, print the <strong>0-based index</strong> of <code>target</code> if present, or <code>-1</code> if it is not in the array.</p>',
      '<h4>Input format</h4><ul><li>Line 1: <code>n target</code>.</li><li>Line 2: <code>n</code> sorted integers.</li></ul>',
    ].join(''),
    starterCode: {
      PYTHON: 'n, target = map(int, input().split())\nnums = list(map(int, input().split()))\n# TODO: implement binary search\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst t = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconst [n, target] = t;\nconst nums = t.slice(2, 2 + n);\n// TODO: implement binary search\n',
    },
    testCases: [
      { input: '5 7\n1 3 5 7 9', expectedOutput: '3', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '5 4\n1 3 5 7 9', expectedOutput: '-1', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '5 1\n1 3 5 7 9', expectedOutput: '0', isHidden: true, weight: 1, comparison: 'TRIMMED' },
      { input: '5 9\n1 3 5 7 9', expectedOutput: '4', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: '1 10\n10', expectedOutput: '0', isHidden: true, weight: 2, comparison: 'TRIMMED' },
    ],
  },
  {
    id: 'grade-transmutation',
    keywords: ['grade', 'grading', 'passing', 'gpa', 'gwa', 'score', 'remark', 'transmut'],
    difficulty: 'EASY',
    title: 'Collegiate Grade Equivalent Classifier',
    statementHtml: [
      '<p>Write a program that reads an integer percentage score <code>s</code> (<code>0 &le; s &le; 100</code>) and prints its collegiate grade equivalent and remark:</p>',
      '<ul><li><code>97–100</code>: <code>1.00 PASSED</code></li><li><code>94–96</code>: <code>1.25 PASSED</code></li><li><code>91–93</code>: <code>1.50 PASSED</code></li><li><code>88–90</code>: <code>1.75 PASSED</code></li><li><code>85–87</code>: <code>2.00 PASSED</code></li><li><code>82–84</code>: <code>2.25 PASSED</code></li><li><code>79–81</code>: <code>2.50 PASSED</code></li><li><code>76–78</code>: <code>2.75 PASSED</code></li><li><code>75</code>: <code>3.00 PASSED</code></li><li><code>0–74</code>: <code>5.00 FAILED</code></li></ul>',
    ].join(''),
    starterCode: {
      PYTHON: 's = int(input().strip())\n# TODO: map percentage score s to grade and PASSED/FAILED\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst s = Number(fs.readFileSync(0, "utf8").trim());\n// TODO: map score s to grade and PASSED/FAILED\n',
    },
    testCases: [
      { input: '98', expectedOutput: '1.00 PASSED', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '74', expectedOutput: '5.00 FAILED', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '75', expectedOutput: '3.00 PASSED', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: '86', expectedOutput: '2.00 PASSED', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: '0', expectedOutput: '5.00 FAILED', isHidden: true, weight: 1, comparison: 'TRIMMED' },
    ],
  },
  {
    id: 'matrix-row-sums',
    keywords: ['matrix', '2d', 'grid', 'row', 'column', 'table'],
    difficulty: 'MEDIUM',
    title: 'Matrix Row Sums',
    statementHtml: [
      '<p>Read an <code>r &times; c</code> matrix of integers and print the sum of each row on its own line.</p>',
      '<h4>Input format</h4><ul><li>Line 1: <code>r c</code> (<code>1 &le; r, c &le; 100</code>).</li><li>Next <code>r</code> lines: <code>c</code> space-separated integers per row.</li></ul>',
    ].join(''),
    starterCode: {
      PYTHON: 'r, c = map(int, input().split())\nfor _ in range(r):\n    row = list(map(int, input().split()))\n    # TODO: print sum of row\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst lines = fs.readFileSync(0, "utf8").trim().split(/\\n+/);\nconst [r, c] = lines[0].trim().split(/\\s+/).map(Number);\n// TODO: print each row sum\n',
    },
    testCases: [
      { input: '2 3\n1 2 3\n4 5 6', expectedOutput: '6\n15', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '3 2\n-1 4\n0 0\n7 -2', expectedOutput: '3\n0\n5', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '1 4\n10 20 30 40', expectedOutput: '100', isHidden: true, weight: 2, comparison: 'TRIMMED' },
    ],
  },
  {
    id: 'balanced-brackets',
    keywords: ['stack', 'bracket', 'parenthes', 'balanced', 'brace', 'queue', 'lifo'],
    difficulty: 'HARD',
    title: 'Balanced Brackets Validator',
    statementHtml: [
      '<p>Given a string consisting solely of bracket characters <code>(</code>, <code>)</code>, <code>[</code>, <code>]</code>, <code>{</code>, and <code>}</code>, determine whether every opening bracket is matched and properly nested by its corresponding closing bracket.</p>',
      '<h4>Output format</h4><p>Print <code>VALID</code> if balanced, or <code>INVALID</code> otherwise.</p>',
    ].join(''),
    starterCode: {
      PYTHON: 's = input().strip()\n# TODO: use a stack to verify matching brackets\n',
      JAVASCRIPT: 'const fs = require("fs");\nconst s = fs.readFileSync(0, "utf8").trim();\n// TODO: use a stack to verify matching brackets\n',
    },
    testCases: [
      { input: '({[]})', expectedOutput: 'VALID', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '([)]', expectedOutput: 'INVALID', isHidden: false, weight: 1, comparison: 'TRIMMED' },
      { input: '()[]{}', expectedOutput: 'VALID', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: '(((', expectedOutput: 'INVALID', isHidden: true, weight: 2, comparison: 'TRIMMED' },
      { input: '}', expectedOutput: 'INVALID', isHidden: true, weight: 1, comparison: 'TRIMMED' },
    ],
  },
];

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matchTemplate(topic, details) {
  const haystack = `${topic ?? ''} ${details ?? ''}`.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const tpl of PROGRAMMING_TEMPLATES) {
    let score = 0;
    for (const kw of tpl.keywords) {
      if (new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i').test(haystack)) {
        score += kw.includes(' ') ? 3 : 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = tpl;
    }
  }
  return bestScore > 0 ? best : null;
}

export function generateProgrammingProblem({
  topic,
  allowedLanguages = ['PYTHON'],
  difficulty = 'MEDIUM',
  details = '',
  testCount = 5,
} = {}) {
  const langs = Array.isArray(allowedLanguages) && allowedLanguages.length > 0 ? allowedLanguages : ['PYTHON'];
  const count = Math.min(Math.max(Number(testCount) || 5, 2), 12);
  const matched = matchTemplate(topic, details);

  if (matched) {
    const starterCode = {};
    for (const lang of langs) {
      starterCode[lang] = matched.starterCode[lang] ?? STARTER_BOILERPLATE[lang] ?? '';
    }
    const tests = matched.testCases.slice(0, Math.max(2, count));
    const extraDetail = details ? `<p><strong>Teacher note:</strong> ${escHtml(cleanLine(details, 400))}</p>` : '';
    return {
      title: matched.title,
      statementHtml: `${matched.statementHtml}${extraDetail}`,
      allowedLanguages: langs,
      starterCode,
      timeLimitMs: difficulty === 'HARD' ? 4000 : 3000,
      memoryLimitKb: 131_072,
      partialCredit: true,
      testCases: tests,
    };
  }

  const label = cleanLine(topic, 120) || 'Custom Problem';
  const starterCode = {};
  for (const lang of langs) {
    starterCode[lang] = STARTER_BOILERPLATE[lang] ?? '';
  }
  const cases = [
    { input: '1\n5', expectedOutput: '5', isHidden: false, weight: 1, comparison: 'TRIMMED' },
    { input: '3\n2 4 6', expectedOutput: '12', isHidden: false, weight: 1, comparison: 'TRIMMED' },
    { input: '2\n10 15', expectedOutput: '25', isHidden: true, weight: 2, comparison: 'TRIMMED' },
    { input: '1\n0', expectedOutput: '0', isHidden: true, weight: 2, comparison: 'TRIMMED' },
  ].slice(0, count);

  return {
    title: label.charAt(0).toUpperCase() + label.slice(1),
    statementHtml: [
      `<p>Write a program for <strong>${escHtml(label)}</strong>.</p>`,
      details ? `<p>${escHtml(cleanLine(details, 500))}</p>` : '',
      '<h4>Input &amp; output format (review before publishing)</h4>',
      '<p>Read the test input from standard input (<code>stdin</code>) and print the exact required result to standard output (<code>stdout</code>). Review and customize the sample and hidden test cases below to match your exact specification.</p>',
    ].filter(Boolean).join(''),
    allowedLanguages: langs,
    starterCode,
    timeLimitMs: 3000,
    memoryLimitKb: 131_072,
    partialCredit: true,
    testCases: cases,
  };
}
