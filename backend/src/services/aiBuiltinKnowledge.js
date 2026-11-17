// Curated, offline curriculum knowledge packs for the built-in zero-key assistant.
// Every fact, definition, comparison, sequence, and worked example here is vetted and deterministic.
// Used when teacher-supplied reference material is sparse or topic-only, and to enrich distractors
// and misconceptions within the right academic domain (never mixing Biology into CS, etc.).

const PACKS = [
  {
    id: 'recursion',
    domain: 'Computer Science',
    title: 'Recursion & the Call Stack',
    triggers: ['recursion', 'recursive', 'base case', 'call stack', 'fibonacci', 'factorial', 'divide and conquer'],
    objectives: [
      'Distinguish the base case from the recursive step in a recursive function',
      'Trace function activation frames on the call stack during recursive execution',
      'Identify when recursion causes infinite loops or stack overflow errors',
      'Compare iterative and recursive implementations by readability, time, and memory overhead',
    ],
    definitions: [
      { term: 'Base case', definition: 'the terminating condition that stops further recursive calls and returns a direct result' },
      { term: 'Recursive step', definition: 'the branch where a function calls itself with a smaller or simpler subproblem moving toward the base case' },
      { term: 'Call stack', definition: 'the LIFO memory structure that stores active function frames, local variables, and return addresses' },
      { term: 'Stack overflow', definition: 'a runtime failure triggered when unbounded or deeply nested calls exhaust the available call stack memory' },
      { term: 'Memoization', definition: 'caching previously computed recursive subproblem results to avoid redundant exponential work' },
    ],
    facts: [
      { statement: 'Every terminating recursive function requires at least one reachable base case and a recursive step that progresses strictly toward it.', misconception: 'A recursive function can terminate reliably without a base case as long as it uses a return statement.', bloom: 'understand' },
      { statement: 'Each recursive call pushes a new activation frame onto the call stack, consuming O(depth) extra stack memory.', misconception: 'Recursive calls reuse the exact same stack frame in standard Python and Java without tail-call optimization.', bloom: 'analyze' },
      { statement: 'Naive recursive Fibonacci recomputes identical subproblems repeatedly, yielding O(2^n) exponential time unless memoized.', misconception: 'Naive recursive Fibonacci runs in O(n) linear time because it only adds two numbers per call.', bloom: 'analyze' },
      { statement: 'If the recursive argument never moves closer to the base case, execution continues until the runtime raises a stack overflow error.', misconception: 'Missing a base case automatically converts recursion into an O(1) constant-time loop.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Iteration (Loops)', right: 'Recursion', contrast: 'Iteration repeats via loop state in O(1) stack space, whereas recursion decomposes a problem into self-similar calls using call-stack frames' },
      { left: 'Base case', right: 'Recursive step', contrast: 'The base case ends recursion immediately without another self-call, while the recursive step reduces the input and calls the function again' },
    ],
    sequences: [
      {
        title: 'Execution trace of factorial(3)',
        steps: [
          'Call factorial(3), pushing its frame onto the call stack',
          'Call factorial(2) and factorial(1) as subproblems shrink',
          'Hit base case factorial(0) returning 1 without further calls',
          'Unwind frames in reverse order: 1 * 1 -> 2 * 1 -> 3 * 2 = 6',
        ],
      },
    ],
    workedExample: {
      title: 'Tracing factorial(n) Safely',
      code: 'def factorial(n):\n    if n < 0:\n        raise ValueError("n must be non-negative")\n    if n <= 1:          # Base case\n        return 1\n    return n * factorial(n - 1)  # Recursive step',
      walkthrough: 'For factorial(4): calls stack as 4 -> 3 -> 2 -> 1. At n == 1, the base case returns 1, and frames unwind computing 2*1=2, 3*2=6, and 4*6=24.',
      takeaway: 'Checking n < 0 prevents infinite recursion on negative inputs.',
    },
    pitfalls: ['Forgetting the base case or checking == 0 on negative inputs', 'Mutating shared mutable defaults across recursive calls', 'Recomputing overlapping subproblems without memoization'],
  },
  {
    id: 'sorting-searching',
    domain: 'Computer Science',
    title: 'Searching & Sorting Algorithms',
    triggers: ['binary search', 'linear search', 'sorting', 'quicksort', 'mergesort', 'merge sort', 'bubble sort', 'insertion sort', 'big o', 'time complexity', 'asymptotic'],
    objectives: [
      'Apply binary search preconditions and trace midpoint narrowing on sorted arrays',
      'Compare O(n log n) divide-and-conquer sorts against O(n^2) elementary sorts',
      'Evaluate best, average, and worst-case time and space complexity trade-offs',
    ],
    definitions: [
      { term: 'Binary search', definition: 'a divide-and-conquer search on a sorted sequence that halves the search interval in O(log n) time' },
      { term: 'Merge sort', definition: 'a stable O(n log n) divide-and-conquer sorting algorithm that splits the input in half and merges sorted subarrays' },
      { term: 'Quicksort', definition: 'an in-place partitioning sort with O(n log n) average time and O(n^2) worst-case time on unbalanced pivots' },
      { term: 'Stable sort', definition: 'a sorting algorithm that preserves the original relative order of elements with equal keys' },
      { term: 'Big-O notation', definition: 'an asymptotic upper bound describing how runtime or memory grows relative to input size n' },
    ],
    facts: [
      { statement: 'Binary search requires the array to be sorted beforehand; otherwise halving around the midpoint can discard the target.', misconception: 'Binary search works accurately on any unsorted array as long as all elements are distinct.', bloom: 'understand' },
      { statement: 'Merge sort guarantees O(n log n) worst-case runtime while requiring O(n) auxiliary space for merging.', misconception: 'Merge sort operates completely in-place with O(1) extra space and O(n^2) worst-case time.', bloom: 'analyze' },
      { statement: 'Insertion sort runs in O(n) time when the input is already nearly sorted, outperforming unoptimized quadratic scans.', misconception: 'Insertion sort always takes O(n^2) comparisons even on an already sorted list.', bloom: 'apply' },
      { statement: 'Quicksort degrades to O(n^2) when poor pivot selection repeatedly splits an array into sizes 0 and n - 1.', misconception: 'Quicksort always guarantees O(n log n) worst-case time regardless of pivot choice.', bloom: 'analyze' },
    ],
    comparisons: [
      { left: 'Linear search', right: 'Binary search', contrast: 'Linear search checks items sequentially in O(n) on any list, whereas binary search requires sorted order to achieve O(log n)' },
      { left: 'Merge sort', right: 'Quicksort', contrast: 'Merge sort is stable with guaranteed O(n log n) worst-case and O(n) space, while standard quicksort uses O(log n) stack space average and has O(n^2) worst case' },
    ],
    sequences: [
      {
        title: 'Binary search iteration steps',
        steps: [
          'Verify the input array is sorted and initialize low = 0, high = n - 1',
          'Compute mid = low + Math.floor((high - low) / 2)',
          'Compare array[mid] with target and return mid if equal',
          'Update low = mid + 1 or high = mid - 1 until target is found or low > high',
        ],
      },
    ],
    workedExample: {
      title: 'Binary Search Trace on [4, 9, 15, 22, 31, 47] for target 31',
      code: 'low=0, high=5 -> mid=2 (val 15 < 31) -> low=3\nlow=3, high=5 -> mid=4 (val 31 == 31) -> return index 4',
      walkthrough: 'Only 2 comparisons locate 31 out of 6 elements because each comparison discards half of the remaining range.',
      takeaway: 'Using low + Math.floor((high - low) / 2) avoids integer overflow in languages with fixed-width integers.',
    },
    pitfalls: ['Running binary search on unsorted data', 'Off-by-one loop bounds (low < high vs low <= high)', 'Forgetting auxiliary space in Merge Sort'],
  },
  {
    id: 'data-structures',
    domain: 'Computer Science',
    title: 'Core Data Structures',
    triggers: ['data structure', 'data structures', 'linked list', 'stack', 'queue', 'hash table', 'binary tree', 'graph', 'fifo', 'lifo'],
    objectives: [
      'Select between arrays, linked lists, stacks, queues, trees, and hash tables based on operation costs',
      'Distinguish LIFO stack behavior from FIFO queue behavior',
      'Analyze collision handling and O(1) average lookup in hash tables',
    ],
    definitions: [
      { term: 'Stack', definition: 'a linear data structure following Last-In, First-Out (LIFO) insertion and removal at the top' },
      { term: 'Queue', definition: 'a linear data structure following First-In, First-Out (FIFO) enqueue at the rear and dequeue at the front' },
      { term: 'Hash table', definition: 'an associative structure mapping keys via a hash function to buckets for O(1) average-case lookup' },
      { term: 'Linked list', definition: 'a sequence of nodes where each node stores data and a reference to the next node without requiring contiguous memory' },
      { term: 'Binary search tree', definition: 'a rooted tree where every node exceeds keys in its left subtree and is smaller than keys in its right subtree' },
    ],
    facts: [
      { statement: 'Arrays support O(1) random index access via contiguous memory offsets, while inserting at index 0 shifts elements in O(n) time.', misconception: 'Arrays allow O(1) insertion at the front without shifting existing elements.', bloom: 'understand' },
      { statement: 'Singly linked lists insert or remove at the head in O(1) time when given a pointer, but indexing the k-th element requires O(k) traversal.', misconception: 'Linked lists provide O(1) random access to any index just like arrays.', bloom: 'analyze' },
      { statement: 'Breadth-first search (BFS) uses a FIFO queue to explore vertices level by level.', misconception: 'Breadth-first search relies on a LIFO stack rather than a queue to expand nodes by distance.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Stack (LIFO)', right: 'Queue (FIFO)', contrast: 'A stack pops the most recently pushed element, whereas a queue dequeues the earliest enqueued element' },
      { left: 'Array', right: 'Linked list', contrast: 'Arrays offer O(1) indexed access in contiguous memory, while linked lists offer O(1) head splicing using pointer overhead per node' },
    ],
    sequences: [
      {
        title: 'Balanced-parentheses check using a stack',
        steps: [
          'Scan the expression characters from left to right',
          'Push opening brackets onto the stack',
          'On a closing bracket, verify the stack is non-empty and pop a matching opener',
          'Confirm the stack is completely empty after the final character',
        ],
      },
    ],
    workedExample: {
      title: 'Choosing Queue vs Stack in Web Backend Tasks',
      code: 'Print jobs / background worker tasks -> Queue (FIFO fairness)\nBrowser Back button / undo history -> Stack (LIFO most recent first)',
      walkthrough: 'Matching access order (FIFO vs LIFO) directly determines whether the oldest or newest pending item is processed first.',
      takeaway: 'Choose structures by dominant operations (lookup, front insert, order policy), not habit.',
    },
    pitfalls: ['Popping or peeking from an empty stack or queue without checking underflow', 'Confusing BFS (queue) with DFS (stack/recursion)', 'Assuming hash table worst case is always O(1) under adversarial collisions'],
  },
  {
    id: 'oop',
    domain: 'Computer Science',
    title: 'Object-Oriented Programming (OOP)',
    triggers: ['oop', 'object oriented', 'object-oriented', 'encapsulation', 'inheritance', 'polymorphism', 'abstraction', 'interface', 'subclass'],
    objectives: [
      'Explain the four pillars of OOP: encapsulation, abstraction, inheritance, and polymorphism',
      'Differentiate composition from inheritance when designing reusable classes',
      'Demonstrate method overriding and runtime polymorphism with clean interfaces',
    ],
    definitions: [
      { term: 'Encapsulation', definition: 'bundling data and methods inside a class while restricting direct external mutation of internal state' },
      { term: 'Polymorphism', definition: 'allowing objects of different classes to respond to the same method call through shared interfaces or overridden methods' },
      { term: 'Inheritance', definition: 'deriving a specialized subclass from a base class to reuse shared attributes and behavior' },
      { term: 'Abstraction', definition: 'exposing essential behavior through simplified interfaces while hiding implementation details' },
    ],
    facts: [
      { statement: 'Encapsulation protects class invariants by exposing controlled getter/setter or domain methods instead of raw mutable fields.', misconception: 'Encapsulation means making all fields public so subclasses can mutate state freely.', bloom: 'understand' },
      { statement: 'Method overriding occurs when a subclass provides a specialized implementation of a method signature defined in its parent or interface.', misconception: 'Method overriding requires changing the parameter types while keeping different return behavior in the same class.', bloom: 'understand' },
      { statement: 'Favoring composition ("has-a") over deep inheritance ("is-a") prevents fragile base-class coupling.', misconception: 'Deep multi-level inheritance hierarchies are always easier to maintain than composition.', bloom: 'analyze' },
    ],
    comparisons: [
      { left: 'Overriding', right: 'Overloading', contrast: 'Overriding redefines an inherited method signature at runtime in a subclass, while overloading defines multiple methods with the same name and different parameter lists' },
      { left: 'Inheritance ("is-a")', right: 'Composition ("has-a")', contrast: 'Inheritance extends a parent class directly, whereas composition delegates behavior to contained helper objects' },
    ],
    sequences: [
      {
        title: 'Designing an encapsulated domain class',
        steps: [
          'Identify the entity responsibilities and invariants',
          'Mark internal state fields private or protected',
          'Expose public behavior methods that validate state transitions',
          'Define common interfaces so callers rely on abstractions',
        ],
      },
    ],
    workedExample: {
      title: 'Polymorphic Payment Processors',
      code: 'class CardPayment { pay(amount) { ... } }\nclass CashPayment { pay(amount) { ... } }\nfunction checkout(method, total) { return method.pay(total); }',
      walkthrough: 'checkout() depends only on the pay(amount) contract, so new payment types require zero edits to checkout().',
      takeaway: 'Polymorphism replaces brittle if/else type checks with interchangeable objects.',
    },
    pitfalls: ['Misusing inheritance solely for code reuse when no "is-a" relationship holds', 'Confusing overloading with overriding', 'Exposing mutable internal collections directly from getters'],
  },
  {
    id: 'sql-databases',
    domain: 'Computer Science & Information Systems',
    title: 'Relational Databases & SQL',
    triggers: ['sql', 'database', 'databases', 'rdbms', 'join', 'joins', 'primary key', 'foreign key', 'normalization', '1nf', '2nf', '3nf', 'acid', 'erd'],
    objectives: [
      'Write relational queries using SELECT, WHERE, GROUP BY, HAVING, and JOIN clauses',
      'Enforce entity and referential integrity with primary and foreign keys',
      'Normalize tables to Third Normal Form (3NF) to eliminate update anomalies',
    ],
    definitions: [
      { term: 'Primary key', definition: 'a column or minimal set of columns that uniquely identifies each row in a table and cannot be NULL' },
      { term: 'Foreign key', definition: 'an attribute referencing a primary or unique key in another table to enforce referential integrity' },
      { term: 'INNER JOIN', definition: 'a relational join returning only rows whose join condition matches in both tables' },
      { term: 'LEFT JOIN', definition: 'a relational join preserving all rows from the left table and filling unmatched right columns with NULL' },
      { term: 'Third Normal Form (3NF)', definition: 'a relation in 2NF with no transitive dependencies between non-key attributes and the primary key' },
    ],
    facts: [
      { statement: 'WHERE filters individual rows before grouping, whereas HAVING filters aggregated groups produced by GROUP BY.', misconception: 'WHERE and HAVING are interchangeable because both filter rows after aggregate functions execute.', bloom: 'apply' },
      { statement: 'Normalization eliminates insertion, update, and deletion anomalies caused by storing duplicated facts in one wide table.', misconception: 'Database normalization slows down integrity by duplicating identical records across rows.', bloom: 'understand' },
      { statement: 'ACID transactions guarantee Atomicity, Consistency, Isolation, and Durability across concurrent database operations.', misconception: 'Atomicity in ACID allows half of a transaction to commit when the remaining queries fail.', bloom: 'remember' },
    ],
    comparisons: [
      { left: 'INNER JOIN', right: 'LEFT JOIN', contrast: 'INNER JOIN drops non-matching left rows, while LEFT JOIN keeps every left row with NULLs for missing right matches' },
      { left: 'WHERE', right: 'HAVING', contrast: 'WHERE filters raw rows prior to GROUP BY aggregation, whereas HAVING filters groups after aggregates like COUNT or SUM' },
    ],
    sequences: [
      {
        title: 'Logical SQL query evaluation order',
        steps: [
          'FROM and JOIN combine the source tables',
          'WHERE filters individual rows before grouping',
          'GROUP BY aggregates rows and HAVING filters groups',
          'SELECT projects expressions, ORDER BY sorts, and LIMIT restricts output',
        ],
      },
    ],
    workedExample: {
      title: 'Counting Enrolled Students per Course Including Empty Courses',
      code: 'SELECT c.code, COUNT(e.student_id) AS enrolled\nFROM courses c\nLEFT JOIN enrollments e ON e.course_id = c.id\nGROUP BY c.id, c.code\nHAVING COUNT(e.student_id) < 30;',
      walkthrough: 'LEFT JOIN keeps courses with zero enrollments so COUNT(e.student_id) returns 0 instead of dropping the course; HAVING filters the resulting counts.',
      takeaway: 'Use COUNT(column) rather than COUNT(*) on LEFT JOINs so NULL rows count as 0 instead of 1.',
    },
    pitfalls: ['Using COUNT(*) instead of COUNT(right_col) on LEFT JOINs', 'Putting aggregate functions inside WHERE instead of HAVING', 'Forgetting an index on frequently joined foreign keys'],
  },
  {
    id: 'web-http',
    domain: 'Web Development',
    title: 'Web Architecture, HTML/CSS & REST APIs',
    triggers: ['html', 'css', 'dom', 'http', 'https', 'rest', 'api', 'apis', 'json', 'status code', 'frontend', 'backend', 'web development'],
    objectives: [
      'Build semantic HTML documents styled with responsive CSS layouts',
      'Design stateless REST APIs using appropriate HTTP methods and status codes',
      'Trace client-server request/response cycles including headers, JSON bodies, and CORS/auth',
    ],
    definitions: [
      { term: 'HTTP GET', definition: 'a safe, idempotent request method used to retrieve a resource without modifying server state' },
      { term: 'Idempotency', definition: 'the property where repeating the exact same request produces the same server resource state as sending it once' },
      { term: 'Semantic HTML', definition: 'using meaningful elements such as <header>, <nav>, <main>, and <article> to convey structure to browsers and assistive tools' },
      { term: 'REST API', definition: 'an architectural style exposing resources via uniform URLs, standard HTTP verbs, and stateless representations like JSON' },
    ],
    facts: [
      { statement: 'HTTP 201 indicates a new resource was created, 400/422 signals invalid client input, and 401 vs 403 distinguishes unauthenticated from forbidden access.', misconception: 'HTTP 401 and 200 both indicate successful authentication with missing permissions.', bloom: 'apply' },
      { statement: 'PUT and DELETE are idempotent HTTP methods, whereas POST is generally non-idempotent because repeating it creates duplicate resources.', misconception: 'POST is defined as idempotent while GET is allowed to mutate database records safely.', bloom: 'understand' },
      { statement: 'Browser CORS policies restrict cross-origin JavaScript responses unless the server explicitly permits the origin via Access-Control-Allow-Origin.', misconception: 'CORS runs on the database server to block SQL injection queries.', bloom: 'understand' },
    ],
    comparisons: [
      { left: '401 Unauthorized', right: '403 Forbidden', contrast: '401 means the caller is not authenticated (missing or invalid credentials), while 403 means an authenticated caller lacks permission' },
      { left: 'PUT', right: 'PATCH', contrast: 'PUT replaces a target resource representation completely, whereas PATCH applies partial updates to specific fields' },
    ],
    sequences: [
      {
        title: 'Browser to REST API request lifecycle',
        steps: [
          'Resolve domain via DNS and establish TLS/TCP connection',
          'Send HTTP method, path, headers, and optional JSON payload',
          'Server authenticates caller, validates input, and updates/reads storage',
          'Return HTTP status code and JSON response body to update the UI',
        ],
      },
    ],
    workedExample: {
      title: 'Designing Idempotent Module Creation',
      code: 'POST /api/modules -> 201 Created { "id": "mod_42", ... }\nPUT /api/modules/mod_42 -> 200 OK { ... }',
      walkthrough: 'If a client retries PUT with the same payload, the resource stays identical; retrying an unguarded POST creates two modules unless a clientRequestId deduplicates it.',
      takeaway: 'Use HTTP semantics cleanly so caches, retries, and error handlers behave predictably.',
    },
    pitfalls: ['Mutating state inside GET handlers', 'Using 200 OK for validation errors instead of 400/422', 'Trusting client-side validation alone without server validation'],
  },
  {
    id: 'networking-security',
    domain: 'IT & Cybersecurity',
    title: 'Computer Networks & Cybersecurity',
    triggers: ['network', 'networking', 'tcp', 'udp', 'ip address', 'osi', 'dns', 'cybersecurity', 'encryption', 'hashing', 'tls', 'https', 'phishing', 'firewall'],
    objectives: [
      'Differentiate TCP reliable transport from UDP low-latency datagrams',
      'Explain how DNS, IP routing, and TLS/HTTPS work together for secure web communication',
      'Contrast cryptographic hashing with symmetric and asymmetric encryption',
    ],
    definitions: [
      { term: 'DNS', definition: 'the distributed naming system that translates human-readable domain names into IP addresses' },
      { term: 'TCP', definition: 'a connection-oriented transport protocol guaranteeing ordered, reliable byte delivery via acknowledgments and retransmissions' },
      { term: 'UDP', definition: 'a connectionless transport protocol offering minimal overhead without delivery guarantees, suited to live audio/video or DNS' },
      { term: 'Password hashing', definition: 'a one-way transformation with a random salt (such as Argon2 or bcrypt) that verifies passwords without storing plaintext' },
      { term: 'HTTPS (TLS)', definition: 'HTTP encrypted in transit using TLS certificates for server authentication, confidentiality, and tamper detection' },
    ],
    facts: [
      { statement: 'Encryption is reversible with a decryption key, whereas cryptographic hashing is one-way and cannot be inverted back to plaintext.', misconception: 'SHA-256 hashing is an encryption method that servers decrypt using a private key.', bloom: 'understand' },
      { statement: 'Adding a unique per-user salt before hashing prevents identical passwords from producing identical digests or falling to precomputed rainbow tables.', misconception: 'Salting passwords is unnecessary when using fast unkeyed hashes like raw MD5.', bloom: 'apply' },
      { statement: 'Principle of least privilege grants users and services only the minimum permissions necessary to perform their duties.', misconception: 'Granting administrator rights to every microservice simplifies least-privilege auditing.', bloom: 'understand' },
    ],
    comparisons: [
      { left: 'Encryption', right: 'Hashing', contrast: 'Encryption protects confidentiality reversibly with a key, while hashing creates a fixed one-way digest for integrity or password verification' },
      { left: 'TCP', right: 'UDP', contrast: 'TCP ensures ordered, acknowledged delivery with handshake overhead, whereas UDP sends fast independent datagrams without retransmission' },
    ],
    sequences: [
      {
        title: 'TCP three-way handshake',
        steps: [
          'Client sends a SYN packet with an initial sequence number',
          'Server replies with SYN-ACK acknowledging the client sequence',
          'Client sends ACK to complete connection establishment',
        ],
      },
    ],
    workedExample: {
      title: 'Why TLS Protects Login Credentials Over Public Wi-Fi',
      code: 'Browser -> TLS Handshake (verify certificate + negotiate session key) -> Encrypted HTTPS POST /login',
      walkthrough: 'Even if an eavesdropper captures packets on public Wi-Fi, TLS encrypts headers and body and verifies the server identity via certificate signatures.',
      takeaway: 'Never send session cookies or credentials over unencrypted HTTP.',
    },
    pitfalls: ['Encrypting passwords reversibly instead of salted hashing', 'Confusing encoding (Base64) with encryption', 'Disabling TLS certificate checks in production clients'],
  },
  {
    id: 'os-git',
    domain: 'Computer Science',
    title: 'Operating Systems & Version Control',
    triggers: ['operating system', 'operating systems', 'process', 'thread', 'deadlock', 'cpu scheduling', 'virtual memory', 'git', 'version control'],
    objectives: [
      'Distinguish OS processes (isolated address spaces) from threads (shared memory)',
      'Identify the four Coffman conditions required for resource deadlock',
      'Use branching, commits, and pull requests cleanly in Git workflows',
    ],
    definitions: [
      { term: 'Process', definition: 'an executing program instance with its own isolated virtual address space and system resources' },
      { term: 'Thread', definition: 'the smallest schedulable execution unit within a process sharing its heap memory and file descriptors' },
      { term: 'Deadlock', definition: 'a state where a set of processes or threads wait indefinitely for resources held by each other' },
      { term: 'Virtual memory', definition: 'an OS abstraction mapping program virtual addresses to physical RAM frames and swap storage via page tables' },
    ],
    facts: [
      { statement: 'Deadlock requires four simultaneous conditions: mutual exclusion, hold-and-wait, no preemption, and circular wait.', misconception: 'Deadlock happens whenever two threads read the same immutable variable concurrently.', bloom: 'understand' },
      { statement: 'Threads within the same process share heap memory for fast communication, but require synchronization primitives to prevent race conditions.', misconception: 'Every thread has a completely separate virtual memory space isolated from sibling threads.', bloom: 'analyze' },
    ],
    comparisons: [
      { left: 'Process', right: 'Thread', contrast: 'Processes own separate virtual address spaces and use IPC to communicate, while threads share process memory and context-switch faster' },
      { left: 'git merge', right: 'git rebase', contrast: 'git merge preserves full branching history with a merge commit, whereas git rebase replays commits linearly onto a new base' },
    ],
    sequences: [
      {
        title: 'Safe Git feature workflow',
        steps: [
          'Pull the latest main branch and create a dedicated feature branch',
          'Stage focused changes and write clear commit messages',
          'Run tests locally and push the branch to the remote',
          'Open a pull request for review before merging to main',
        ],
      },
    ],
    workedExample: {
      title: 'Preventing Circular Wait Deadlock',
      code: 'Thread A & Thread B always acquire Lock_1 before Lock_2 -> circular wait impossible',
      walkthrough: 'Enforcing a strict global lock acquisition order breaks the circular wait condition, guaranteeing deadlock cannot form.',
      takeaway: 'Breaking any one of the four deadlock conditions prevents deadlocks.',
    },
    pitfalls: ['Rebasing shared public branches that teammates depend on', 'Sharing unprotected mutable state across threads', 'Acquiring nested locks in inconsistent orders'],
  },
  {
    id: 'calculus',
    domain: 'Mathematics',
    title: 'Differential & Integral Calculus',
    triggers: ['calculus', 'derivative', 'derivatives', 'integral', 'integrals', 'limit', 'limits', 'chain rule', 'product rule', 'differentiation', 'integration'],
    objectives: [
      'Interpret the derivative as an instantaneous rate of change and tangent slope',
      'Apply power, product, quotient, and chain rules accurately',
      'Connect antiderivatives and definite integrals via the Fundamental Theorem of Calculus',
    ],
    definitions: [
      { term: 'Derivative', definition: 'the instantaneous rate of change of a function, defined as the limit of the difference quotient as h approaches 0' },
      { term: 'Chain rule', definition: 'the differentiation rule d/dx[f(g(x))] = f\'(g(x)) * g\'(x) for composite functions' },
      { term: 'Definite integral', definition: 'the signed net area under a curve over [a, b], equal to F(b) - F(a) when F\' = f' },
      { term: 'Critical point', definition: 'an interior point where the first derivative equals zero or is undefined' },
    ],
    facts: [
      { statement: 'If a function is differentiable at a point, it must be continuous there, though a continuous corner like |x| at 0 need not be differentiable.', misconception: 'Every continuous function is guaranteed to be differentiable at all points.', bloom: 'analyze' },
      { statement: 'By the Fundamental Theorem of Calculus, differentiating the accumulated area integral from a to x recovers f(x).', misconception: 'The definite integral measures the slope of the tangent line rather than accumulated net area.', bloom: 'understand' },
    ],
    comparisons: [
      { left: 'Indefinite integral', right: 'Definite integral', contrast: 'An indefinite integral returns a family of antiderivatives + C, whereas a definite integral evaluates to a number representing net signed area on [a, b]' },
    ],
    sequences: [
      {
        title: 'Finding local extrema on [a, b]',
        steps: [
          'Compute the first derivative f\'(x)',
          'Locate all critical points where f\'(x) = 0 or is undefined inside (a, b)',
          'Apply the first or second derivative test and check endpoints a and b',
        ],
      },
    ],
    workedExample: {
      title: 'Differentiating (3x^2 + 1)^4 with the Chain Rule',
      code: 'Outer: u^4 -> 4u^3\nInner: u = 3x^2 + 1 -> du/dx = 6x\nResult: 4(3x^2 + 1)^3 * (6x) = 24x(3x^2 + 1)^3',
      walkthrough: 'Multiply the derivative of the outer power evaluated at the inner expression by the derivative of the inner expression.',
      takeaway: 'Never forget the inner derivative g\'(x) when applying the power rule to nested expressions.',
    },
    pitfalls: ['Omitting g\'(x) in the chain rule', 'Forgetting the constant + C in indefinite integrals', 'Assuming f\'(c) = 0 automatically guarantees a maximum or minimum (e.g., x^3 at 0)'],
  },
  {
    id: 'statistics',
    domain: 'Mathematics & Statistics',
    title: 'Probability & Statistics',
    triggers: ['statistics', 'probability', 'standard deviation', 'variance', 'hypothesis testing', 'p-value', 'mean', 'median', 'normal distribution', 'correlation'],
    objectives: [
      'Choose appropriate measures of center and spread for skewed vs symmetric data',
      'Interpret null hypotheses, p-values, and confidence intervals accurately',
      'Distinguish correlation from causation in observational studies',
    ],
    definitions: [
      { term: 'Standard deviation', definition: 'a measure of typical spread around the mean expressed in the same units as the data' },
      { term: 'Median', definition: 'the middle ordered value of a dataset that resists distortion by extreme outliers' },
      { term: 'p-value', definition: 'the probability of observing results at least as extreme as the sample data assuming the null hypothesis is true' },
      { term: 'Type I error', definition: 'rejecting a true null hypothesis (false positive), bounded by significance level alpha' },
    ],
    facts: [
      { statement: 'Strong correlation (r near +/-1) measures linear association only and does not prove cause and effect without controlled design.', misconception: 'A correlation coefficient above 0.8 proves that the X variable directly causes changes in Y.', bloom: 'analyze' },
      { statement: 'When income or house-price data is heavily right-skewed, the median represents a typical value better than the mean.', misconception: 'The arithmetic mean is less affected by extreme outliers than the median.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Mean', right: 'Median', contrast: 'The mean averages every value and shifts toward outliers, while the median depends on rank order and resists extreme skewness' },
      { left: 'Type I error', right: 'Type II error', contrast: 'Type I wrongly rejects a true null hypothesis (false positive), whereas Type II fails to reject a false null hypothesis (false negative)' },
    ],
    sequences: [
      {
        title: 'Steps in hypothesis testing',
        steps: [
          'Formulate null (H0) and alternative (Ha) hypotheses',
          'Select significance level alpha (commonly 0.05) and appropriate test statistic',
          'Collect sample data and compute test statistic and p-value',
          'Reject H0 if p <= alpha; otherwise fail to reject H0',
        ],
      },
    ],
    workedExample: {
      title: 'Interpreting p = 0.03 at alpha = 0.05',
      code: 'p = 0.03 <= alpha = 0.05 -> Statistically significant evidence against H0',
      walkthrough: 'Assuming H0 were true, a sample difference this large would occur only 3% of the time by chance, so we reject H0.',
      takeaway: 'p = 0.03 does NOT mean there is a 3% chance H0 is true—it conditions on H0 being true.',
    },
    pitfalls: ['Misinterpreting p-value as P(H0 is true)', 'Equating correlation with causation', 'Applying parametric t-tests blindly to tiny heavily skewed samples'],
  },
  {
    id: 'discrete-math',
    domain: 'Mathematics & Computer Science',
    title: 'Discrete Mathematics & Logic',
    triggers: ['discrete math', 'discrete mathematics', 'propositional logic', 'truth table', 'set theory', 'induction', 'combinatorics', 'permutation', 'combination'],
    objectives: [
      'Evaluate compound logical statements using truth tables and De Morgan\'s laws',
      'Distinguish permutations (order matters) from combinations (order does not matter)',
      'Construct valid proofs by mathematical induction with base and inductive steps',
    ],
    definitions: [
      { term: 'Implication (p -> q)', definition: 'a conditional proposition that is false only when hypothesis p is true and conclusion q is false' },
      { term: 'Contrapositive', definition: 'the logically equivalent statement (!q -> !p) formed by negating and swapping p -> q' },
      { term: 'Permutation', definition: 'an ordered arrangement of elements where distinct positions produce distinct outcomes' },
      { term: 'Combination', definition: 'an unordered selection of elements where only membership matters, not sequence' },
    ],
    facts: [
      { statement: 'By De Morgan\'s Laws, negating (p AND q) yields (!p OR !q), and negating (p OR q) yields (!p AND !q).', misconception: 'The negation of (p AND q) is (!p AND !q) without flipping AND to OR.', bloom: 'apply' },
      { statement: 'An implication p -> q is logically equivalent to its contrapositive !q -> !p, but NOT to its converse q -> p.', misconception: 'If p -> q is true, then its converse q -> p must automatically be true.', bloom: 'analyze' },
    ],
    comparisons: [
      { left: 'Permutation', right: 'Combination', contrast: 'Permutations count ordered arrangements (P(n,r) = n!/(n-r)!), while combinations count unordered subsets (C(n,r) = n!/(r!(n-r)!))' },
    ],
    sequences: [
      {
        title: 'Proof by mathematical induction',
        steps: [
          'Prove the base case P(n0) holds directly',
          'State the inductive hypothesis assuming P(k) holds for arbitrary k >= n0',
          'Use P(k) algebraically to prove P(k + 1) holds',
        ],
      },
    ],
    workedExample: {
      title: 'Choosing 3 Committee Members vs 3 Ranked Officers from 10 Students',
      code: 'Unordered committee: C(10, 3) = 120\nPresident, VP, Secretary: P(10, 3) = 720',
      walkthrough: 'When roles are identical (committee), divide out the 3! = 6 orderings; when roles differ, keep order distinct.',
      takeaway: 'Always ask first: does swapping two chosen items create a different outcome?',
    },
    pitfalls: ['Confusing converse with contrapositive', 'Forgetting to flip AND/OR in De Morgan\'s laws', 'Using permutations when order does not matter'],
  },
  {
    id: 'photosynthesis',
    domain: 'Biology',
    title: 'Photosynthesis',
    triggers: ['photosynthesis', 'chloroplast', 'chlorophyll', 'calvin cycle', 'thylakoid', 'stroma', 'light-dependent', 'stomata'],
    objectives: [
      'Trace inputs and outputs of the light-dependent reactions and Calvin cycle',
      'Locate thylakoid vs stroma reaction sites inside the chloroplast',
      'Explain how light, CO2, and water availability affect photosynthetic rate',
    ],
    definitions: [
      { term: 'Chlorophyll', definition: 'the primary light-absorbing pigment in thylakoid membranes that absorbs red and blue light and reflects green' },
      { term: 'Thylakoid', definition: 'the internal membrane sac in chloroplasts where light-dependent reactions split water and generate ATP and NADPH' },
      { term: 'Calvin cycle', definition: 'the light-independent reactions in the chloroplast stroma that fix CO2 into G3P sugars using ATP and NADPH' },
      { term: 'Stomata', definition: 'microscopic leaf pores that regulate CO2 uptake and water vapor transpiration' },
    ],
    facts: [
      { statement: 'Oxygen (O2) released during photosynthesis comes from splitting water (H2O) molecules in the light-dependent reactions, not from CO2.', misconception: 'The O2 gas released by plants comes directly from breaking apart carbon dioxide molecules.', bloom: 'understand' },
      { statement: 'Plants absorb carbon dioxide (CO2) from the air through stomata to build carbohydrates during the Calvin cycle.', misconception: 'Plants absorb oxygen rather than carbon dioxide as their carbon source for sugar synthesis.', bloom: 'remember' },
      { statement: 'The Calvin cycle occurs in the stroma and relies on ATP and NADPH generated by the light reactions in the thylakoids.', misconception: 'The Calvin cycle takes place inside mitochondrial cristae and directly splits water using sunlight.', bloom: 'analyze' },
    ],
    comparisons: [
      { left: 'Light-dependent reactions', right: 'Calvin cycle', contrast: 'Light reactions occur in thylakoid membranes splitting H2O to produce ATP, NADPH, and O2, whereas the Calvin cycle in the stroma consumes ATP and NADPH to fix CO2 into sugar' },
    ],
    sequences: [
      {
        title: 'Energy flow during photosynthesis',
        steps: [
          'Chlorophyll absorbs photons in thylakoid photosystems II and I',
          'Water is split, releasing O2 and driving ATP and NADPH synthesis',
          'Rubisco fixes CO2 in the stroma during the Calvin cycle',
          'ATP and NADPH reduce fixed carbon into G3P sugars',
        ],
      },
    ],
    workedExample: {
      title: 'Overall Balanced Photosynthesis Reaction',
      code: '6 CO2 + 6 H2O + light energy -> C6H12O6 + 6 O2',
      walkthrough: 'Six carbon dioxide molecules supply carbon for one glucose molecule, while water splitting supplies electrons and oxygen gas.',
      takeaway: 'Light reactions capture energy; Calvin cycle fixes carbon.',
    },
    pitfalls: ['Assuming O2 comes from CO2 instead of H2O', 'Calling the Calvin cycle "dark reactions" as if light-reaction ATP/NADPH were optional', 'Confusing chloroplasts with mitochondria'],
  },
  {
    id: 'cellular-respiration',
    domain: 'Biology',
    title: 'Cellular Respiration & Cell Biology',
    triggers: ['cellular respiration', 'glycolysis', 'citric acid', 'krebs', 'oxidative phosphorylation', 'mitochondria', 'pyruvate', 'atp', 'fermentation', 'mitosis', 'meiosis'],
    objectives: [
      'Track glucose breakdown across glycolysis, pyruvate oxidation, the citric acid cycle, and oxidative phosphorylation',
      'Locate cytoplasmic vs mitochondrial stages and account for ATP yield',
      'Contrast aerobic respiration with anaerobic fermentation',
    ],
    definitions: [
      { term: 'Glycolysis', definition: 'the anaerobic cytoplasmic pathway splitting 6-carbon glucose into two 3-carbon pyruvate molecules while yielding net 2 ATP and 2 NADH' },
      { term: 'Citric acid cycle', definition: 'the mitochondrial matrix cycle oxidizing acetyl-CoA to CO2 while generating NADH, FADH2, and GTP/ATP' },
      { term: 'Oxidative phosphorylation', definition: 'electron transport and chemiosmosis across the inner mitochondrial membrane producing the bulk of cellular ATP' },
      { term: 'ATP', definition: 'adenosine triphosphate, the primary immediate energy-transfer nucleotide powering cellular work' },
    ],
    facts: [
      { statement: 'Oxygen serves as the final electron acceptor at the end of the mitochondrial electron transport chain, combining with protons to form water.', misconception: 'Oxygen directly phosphorylates glucose during glycolysis in the cytoplasm.', bloom: 'understand' },
      { statement: 'Glycolysis occurs in the cytosol and proceeds even when oxygen is absent, whereas the citric acid cycle requires mitochondrial electron flow.', misconception: 'Glycolysis occurs exclusively inside the mitochondrial matrix and halts immediately without oxygen.', bloom: 'apply' },
      { statement: 'Mitosis produces two genetically identical diploid daughter cells, whereas meiosis produces four genetically varied haploid gametes.', misconception: 'Mitosis halves chromosome number to create haploid gametes for sexual reproduction.', bloom: 'understand' },
    ],
    comparisons: [
      { left: 'Aerobic respiration', right: 'Fermentation', contrast: 'Aerobic respiration uses O2 in mitochondria to yield ~30-32 ATP per glucose, while fermentation regenerates NAD+ anaerobically for only 2 net ATP' },
      { left: 'Mitosis', right: 'Meiosis', contrast: 'Mitosis performs one division yielding identical diploid somatic cells; meiosis performs two divisions with crossing over yielding haploid gametes' },
    ],
    sequences: [
      {
        title: 'Four stages of aerobic cellular respiration',
        steps: [
          'Glycolysis splits glucose into two pyruvate molecules in the cytoplasm',
          'Pyruvate oxidation converts pyruvate into acetyl-CoA inside mitochondria',
          'Citric acid cycle harvests NADH and FADH2 while releasing CO2',
          'Electron transport chain and ATP synthase drive oxidative phosphorylation',
        ],
      },
    ],
    workedExample: {
      title: 'Why Cyanide Halts ATP Production Rapidly',
      code: 'Cyanide inhibits Complex IV -> electron transport backs up -> H+ gradient collapses -> oxidative phosphorylation stops',
      walkthrough: 'Blocking the final electron transfer to O2 stops NADH oxidation, stalling both oxidative phosphorylation and the citric acid cycle.',
      takeaway: 'Without O2 (or functioning Complex IV), cells fall back to low-yield glycolysis + fermentation.',
    },
    pitfalls: ['Placing glycolysis inside mitochondria instead of the cytosol', 'Thinking oxygen enters glycolysis directly', 'Confusing diploid mitotic products with haploid meiotic gametes'],
  },
  {
    id: 'genetics',
    domain: 'Biology',
    title: 'Genetics & Molecular Biology',
    triggers: ['genetics', 'dna', 'rna', 'transcription', 'translation', 'ribosome', 'mendel', 'allele', 'genotype', 'phenotype', 'mutation'],
    objectives: [
      'Trace genetic information flow from DNA to mRNA (transcription) to protein (translation)',
      'Distinguish genotype, phenotype, dominant/recessive alleles, and Punnett predictions',
      'Evaluate how point mutations affect codons and protein structure',
    ],
    definitions: [
      { term: 'Transcription', definition: 'the synthesis of a complementary RNA strand from a DNA template catalyzed by RNA polymerase' },
      { term: 'Translation', definition: 'the assembly of an amino acid polypeptide chain on a ribosome guided by mRNA codons and tRNA anticodons' },
      { term: 'Genotype', definition: 'an organism\'s underlying allele combination for one or more genes' },
      { term: 'Phenotype', definition: 'the observable physical or physiological trait resulting from genotype and environment' },
    ],
    facts: [
      { statement: 'RNA uses uracil (U) instead of DNA\'s thymine (T) to pair with adenine (A) during transcription.', misconception: 'Messenger RNA retains thymine (T) instead of uracil when transcribed from DNA.', bloom: 'remember' },
      { statement: 'Silent point mutations change a DNA base without altering the encoded amino acid because the genetic code is redundant.', misconception: 'Every single-nucleotide mutation alters the final amino acid sequence of a protein.', bloom: 'analyze' },
    ],
    comparisons: [
      { left: 'Transcription', right: 'Translation', contrast: 'Transcription copies DNA into mRNA in the nucleus (in eukaryotes), while translation decodes mRNA into polypeptide chains at ribosomes' },
      { left: 'DNA', right: 'RNA', contrast: 'DNA is double-stranded with deoxyribose and thymine, whereas RNA is typically single-stranded with ribose and uracil' },
    ],
    sequences: [
      {
        title: 'Central dogma gene expression flow',
        steps: [
          'RNA polymerase binds the DNA promoter region',
          'Transcription synthesizes complementary pre-mRNA (A->U, T->A, C<->G)',
          'Processed mRNA exits to a ribosome in the cytoplasm',
          'tRNA anticodons match mRNA codons to link amino acids into protein',
        ],
      },
    ],
    workedExample: {
      title: 'Transcribing DNA Template 3\'-TAC GGA-5\'',
      code: 'DNA template: 3\'-TAC GGA-5\'\nmRNA transcript: 5\'-AUG CCU-3\' -> Start (Met) - Proline',
      walkthrough: 'Pair T->A, A->U, C->G, G->C to form mRNA before looking up codons in the genetic code chart.',
      takeaway: 'Remember A pairs with U (not T) in RNA.',
    },
    pitfalls: ['Putting T in mRNA transcripts', 'Confusing genotype (alleles) with phenotype (traits)', 'Assuming recessive traits are always rare in populations'],
  },
  {
    id: 'physics',
    domain: 'Physics',
    title: 'Classical Mechanics & Electric Circuits',
    triggers: ['physics', 'newton', 'kinematics', 'velocity', 'acceleration', 'momentum', 'kinetic energy', 'ohm', 'ohms law', 'circuit', 'voltage', 'resistance'],
    objectives: [
      'Apply Newton\'s three laws of motion using free-body force diagrams',
      'Distinguish speed, velocity, and acceleration in kinematic graphs',
      'Solve series and parallel circuit problems using Ohm\'s law (V = IR)',
    ],
    definitions: [
      { term: 'Newton\'s Second Law', definition: 'the principle that net force equals mass times acceleration (F_net = m * a)' },
      { term: 'Momentum', definition: 'the vector product of mass and velocity (p = m * v), conserved in isolated systems without external impulse' },
      { term: 'Ohm\'s Law', definition: 'the linear relation V = I * R linking voltage drop, current, and electrical resistance' },
      { term: 'Acceleration', definition: 'the rate of change of velocity vector over time, occurring whenever speed or direction changes' },
    ],
    facts: [
      { statement: 'An object moving in a circle at constant speed is still accelerating because its velocity vector direction constantly changes.', misconception: 'Circular motion at constant speed has zero acceleration because speed does not change.', bloom: 'analyze' },
      { statement: 'Newton\'s Third Law action-reaction pairs act on two different objects and therefore never cancel each other on a single free-body diagram.', misconception: 'Action and reaction forces act on the same object and always sum to zero net force.', bloom: 'understand' },
      { statement: 'In a parallel circuit, every branch experiences the same voltage while total current splits across branches.', misconception: 'Current stays identical across uneven parallel resistors while voltage splits equally.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Series circuit', right: 'Parallel circuit', contrast: 'Series components share one current path with summing resistances, whereas parallel branches share the same voltage with lower equivalent resistance' },
      { left: 'Mass', right: 'Weight', contrast: 'Mass measures intrinsic inertia in kilograms anywhere, whereas weight is gravitational force (m * g) in newtons' },
    ],
    sequences: [
      {
        title: 'Solving Newton\'s second law problems',
        steps: [
          'Isolate the object of interest and draw a free-body diagram',
          'Resolve all forces into perpendicular x and y components',
          'Sum net forces along each axis and solve F_net = m * a',
          'Verify units (newtons, kg, m/s^2) and physical reasonableness',
        ],
      },
    ],
    workedExample: {
      title: 'Parallel Resistors (6 ohm and 3 ohm across 12 V)',
      code: '1/R_eq = 1/6 + 1/3 = 3/6 -> R_eq = 2 ohms\nTotal I = 12 V / 2 ohms = 6 A (I1 = 2 A, I2 = 4 A)',
      walkthrough: 'Adding a parallel branch lowers total equivalent resistance below the smallest individual branch resistor.',
      takeaway: 'Parallel R_eq is always smaller than every individual branch resistance.',
    },
    pitfalls: ['Canceling Newton 3rd-law pairs on one object', 'Forgetting unit conversions (km/h to m/s, mA to A)', 'Adding parallel resistances directly instead of reciprocals'],
  },
  {
    id: 'chemistry',
    domain: 'Chemistry',
    title: 'Stoichiometry, Bonding & Acids/Bases',
    triggers: ['chemistry', 'stoichiometry', 'mole', 'molarity', 'covalent', 'ionic', 'acid', 'base', 'ph', 'periodic table', 'chemical bond'],
    objectives: [
      'Convert between grams, moles, and molarity in balanced chemical reactions',
      'Differentiate ionic electron transfer from covalent electron sharing',
      'Calculate and interpret pH values for acidic, neutral, and basic solutions',
    ],
    definitions: [
      { term: 'Mole', definition: 'the SI amount of substance containing Avogadro\'s number (6.022 x 10^23) of particles' },
      { term: 'Limiting reactant', definition: 'the reagent completely consumed first in a chemical reaction, fixing the maximum theoretical product yield' },
      { term: 'Covalent bond', definition: 'a chemical bond formed by sharing electron pairs between nonmetal atoms' },
      { term: 'pH scale', definition: 'the negative base-10 logarithm of hydronium ion concentration (-log[H+]), where values below 7 are acidic at 25 C' },
    ],
    facts: [
      { statement: 'Because pH is a logarithmic scale, a solution at pH 3 is ten times more acidic in [H+] than a solution at pH 4.', misconception: 'A solution at pH 3 has twice the hydrogen ion concentration of a solution at pH 6.', bloom: 'apply' },
      { statement: 'Chemical equations must be balanced using stoichiometric coefficients rather than altering subscripts inside chemical formulas.', misconception: 'You can balance chemical reactions by changing molecular subscripts like changing H2O into H2O2.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Ionic bond', right: 'Covalent bond', contrast: 'Ionic bonds transfer electrons between ions with large electronegativity differences, whereas covalent bonds share valence electron pairs' },
    ],
    sequences: [
      {
        title: 'Mass-to-mass stoichiometry workflow',
        steps: [
          'Write and balance the chemical equation',
          'Convert given reactant mass in grams to moles using molar mass',
          'Multiply by the balanced mole ratio to find product moles',
          'Convert product moles back to grams using product molar mass',
        ],
      },
    ],
    workedExample: {
      title: 'Dilution Calculation (M1V1 = M2V2)',
      code: '2.0 M * 50 mL = 0.5 M * V2 -> V2 = 200 mL total (add 150 mL solvent)',
      walkthrough: 'Total moles of solute stay unchanged during dilution; only total solution volume expands.',
      takeaway: 'V2 is final total volume, not the volume of solvent added.',
    },
    pitfalls: ['Comparing reactant masses directly without converting to moles for limiting reagent', 'Changing chemical subscripts while balancing', 'Assuming pH 7 is neutral at every temperature'],
  },
  {
    id: 'accounting',
    domain: 'Business & Accounting',
    title: 'Financial Accounting & Statements',
    triggers: ['accounting', 'balance sheet', 'income statement', 'cash flow', 'debit', 'credit', 'assets', 'liabilities', 'equity', 'accrual', 'journal entry'],
    objectives: [
      'Apply the fundamental accounting equation (Assets = Liabilities + Equity) to transactions',
      'Record balanced double-entry journal debits and credits accurately',
      'Distinguish accrual net income from operating cash flow across financial statements',
    ],
    definitions: [
      { term: 'Accounting equation', definition: 'Assets = Liabilities + Owner\'s Equity, the foundational balance identity of double-entry accounting' },
      { term: 'Accrual accounting', definition: 'recognizing revenues when earned and expenses when incurred regardless of when cash changes hands' },
      { term: 'Balance sheet', definition: 'a point-in-time snapshot reporting a company\'s assets, liabilities, and equity on a specific date' },
      { term: 'Income statement', definition: 'a period financial report summarizing revenues minus expenses to measure net income' },
    ],
    facts: [
      { statement: 'Normal asset and expense accounts increase with debits, whereas liabilities, equity, and revenue accounts increase with credits.', misconception: 'In accounting, credit always means adding money to cash and debit always means deducting.', bloom: 'understand' },
      { statement: 'Collecting cash on an existing accounts receivable shifts one asset (Cash) up and another (Accounts Receivable) down without changing total revenue.', misconception: 'Receiving cash for a prior month\'s billed sale creates new revenue a second time under accrual accounting.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Balance sheet', right: 'Income statement', contrast: 'The balance sheet reports financial position at a single date, while the income statement measures revenue and expense performance over a period' },
      { left: 'Cash basis', right: 'Accrual basis', contrast: 'Cash basis records transactions only when cash moves, whereas accrual records revenues when earned and expenses when incurred' },
    ],
    sequences: [
      {
        title: 'Standard accounting cycle',
        steps: [
          'Analyze source documents and record journal entries',
          'Post journal entries to general ledger accounts',
          'Prepare unadjusted trial balance and adjusting entries',
          'Generate financial statements and post closing entries',
        ],
      },
    ],
    workedExample: {
      title: 'Purchasing PHP 25,000 Equipment on Credit',
      code: 'Dr. Equipment (+Asset)          25,000\n    Cr. Accounts Payable (+Liability)    25,000',
      walkthrough: 'Assets rise by 25,000 and Liabilities rise by 25,000, preserving Assets = Liabilities + Equity with zero immediate income-statement impact.',
      takeaway: 'Every entry requires equal total debits and credits.',
    },
    pitfalls: ['Treating debit/credit as good/bad instead of left/right ledger rules', 'Recording unearned customer deposits as revenue immediately', 'Confusing profit with cash on hand'],
  },
  {
    id: 'economics',
    domain: 'Business & Economics',
    title: 'Microeconomics, Supply & Demand',
    triggers: ['economics', 'supply and demand', 'supply', 'demand', 'elasticity', 'equilibrium', 'opportunity cost', 'inflation', 'gdp', 'macroeconomics'],
    objectives: [
      'Distinguish movements along a demand/supply curve from shifts of the entire curve',
      'Predict equilibrium price and quantity changes after supply or demand shocks',
      'Apply price elasticity of demand to total revenue decisions',
    ],
    definitions: [
      { term: 'Opportunity cost', definition: 'the value of the next-best forgone alternative when making an economic choice' },
      { term: 'Market equilibrium', definition: 'the price and quantity where quantity demanded equals quantity supplied with no shortage or surplus' },
      { term: 'Price elasticity of demand', definition: 'the percentage responsiveness of quantity demanded to a one-percent change in price' },
      { term: 'Price ceiling', definition: 'a legal maximum price set below equilibrium that creates a persistent shortage' },
    ],
    facts: [
      { statement: 'A change in the good\'s own price moves buyers along the existing demand curve, whereas changes in income, tastes, or substitute prices shift the curve.', misconception: 'Lowering a product\'s price shifts its entire demand curve outward to the right.', bloom: 'analyze' },
      { statement: 'When demand is price-inelastic (|Ed| < 1), raising price increases total revenue because quantity demanded drops proportionally less than price rises.', misconception: 'Raising prices on inelastic goods always reduces total seller revenue.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Shortage', right: 'Surplus', contrast: 'A shortage occurs when price sits below equilibrium (Qd > Qs), whereas a surplus occurs when price sits above equilibrium (Qs > Qd)' },
    ],
    sequences: [
      {
        title: 'Analyzing a market shock',
        steps: [
          'Identify whether the event affects buyers (demand), sellers (supply), or both',
          'Determine whether the affected curve shifts left (decrease) or right (increase)',
          'Compare the new intersection equilibrium price and quantity to the original',
        ],
      },
    ],
    workedExample: {
      title: 'Typhoon Damages Rice Harvests',
      code: 'Supply shifts left -> Equilibrium price rises, Equilibrium quantity falls',
      walkthrough: 'Higher production losses reduce supply at every price, driving up market price and lowering quantity consumed.',
      takeaway: 'Do not confuse "quantity demanded fell due to higher price" with a leftward shift in demand.',
    },
    pitfalls: ['Confusing "demand" (curve) with "quantity demanded" (point)', 'Thinking a non-binding price floor above equilibrium causes zero effect? No—floor ABOVE equilibrium creates surplus; ceiling ABOVE equilibrium is non-binding'],
  },
  {
    id: 'research-methods',
    domain: 'Research & Academic Writing',
    title: 'Research Methodology & Academic Integrity',
    triggers: ['research', 'methodology', 'hypothesis', 'sampling', 'qualitative', 'quantitative', 'literature review', 'plagiarism', 'apa', 'citation', 'variables'],
    objectives: [
      'Formulate testable research questions and clear independent/dependent variables',
      'Match quantitative, qualitative, and mixed-methods designs to research goals',
      'Select appropriate probability and non-probability sampling strategies and uphold academic integrity',
    ],
    definitions: [
      { term: 'Independent variable', definition: 'the factor manipulated or categorized by the researcher to test its effect on an outcome' },
      { term: 'Dependent variable', definition: 'the measured outcome expected to respond to changes in the independent variable' },
      { term: 'Simple random sampling', definition: 'a probability sampling method in which every member of the population has an equal known chance of selection' },
      { term: 'Validity', definition: 'the degree to which an instrument or study accurately measures the construct and supports sound conclusions' },
      { term: 'Reliability', definition: 'the consistency and repeatability of measurement results across items, raters, or occasions' },
    ],
    facts: [
      { statement: 'A measurement tool can be highly reliable (consistent) while still lacking validity (measuring the wrong construct).', misconception: 'If a questionnaire yields identical repeated scores, it is automatically valid for any construct.', bloom: 'analyze' },
      { statement: 'Stratified sampling divides a population into subgroups (strata) before random sampling so smaller subgroups are fairly represented.', misconception: 'Convenience sampling guarantees a statistically unbiased random sample of the full population.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Quantitative research', right: 'Qualitative research', contrast: 'Quantitative tests numeric hypotheses across larger samples for generalizability, while qualitative explores lived meaning and context in depth' },
      { left: 'Validity', right: 'Reliability', contrast: 'Validity assesses accuracy (measuring the intended construct), whereas reliability assesses consistency across repeated measurements' },
    ],
    sequences: [
      {
        title: 'Core academic research workflow',
        steps: [
          'Identify a focused problem and review peer-reviewed literature',
          'State hypotheses or research questions and operationalize variables',
          'Select design, ethics safeguards, and sampling plan',
          'Collect and analyze data objectively and report limitations transparently',
        ],
      },
    ],
    workedExample: {
      title: 'Operationalizing Study Habits & Quiz Performance',
      code: 'Independent variable: Spaced practice minutes/week\nDependent variable: Standardized quiz score (0-100)\nControl: Prior GPA and class section',
      walkthrough: 'Defining concrete measurable indicators turns broad ideas into testable variables.',
      takeaway: 'Always verify ethics consent and data privacy before collecting human-participant data.',
    },
    pitfalls: ['Inferring causation from non-experimental surveys', 'Assuming reliability guarantees validity', 'Omitting limitations or citing unverified secondary summaries'],
  },
  {
    id: 'philippine-civics',
    domain: 'Social Science & Philippine Studies',
    title: 'Philippine Constitution, Governance & History',
    triggers: ['philippine constitution', '1987 constitution', 'bill of rights', 'separation of powers', 'rizal', 'noli me tangere', 'el filibusterismo', 'katipunan', 'checks and balances'],
    objectives: [
      'Explain separation of powers and checks and balances under the 1987 Philippine Constitution',
      'Identify key civil and due-process protections under Article III (Bill of Rights)',
      'Connect José Rizal\'s writings and reform/revolutionary movements to Philippine nation-building',
    ],
    definitions: [
      { term: 'Separation of powers', definition: 'the constitutional division of government authority among the Legislative, Executive, and Judicial branches' },
      { term: 'Bill of Rights (Article III)', definition: 'constitutional guarantees protecting life, liberty, property, due process, equal protection, and free expression against state abuse' },
      { term: 'Checks and balances', definition: 'reciprocal constitutional mechanisms enabling each branch to restrain overreach by another, such as presidential veto and judicial review' },
      { term: 'Due process', definition: 'the constitutional requirement of fair laws (substantive) and fair notice and hearing procedures (procedural) before depriving rights' },
    ],
    facts: [
      { statement: 'Under the 1987 Constitution, legislative power is vested in Congress, executive power in the President, and judicial power in the Supreme Court and lower courts.', misconception: 'The Executive branch holds sole authority to declare statutes unconstitutional without judicial review.', bloom: 'remember' },
      { statement: 'In Article III Section 2, searches and seizures generally require a judicial warrant issued upon probable cause determined personally by a judge.', misconception: 'Police officers may obtain search warrants issued solely by municipal mayors without judicial review.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Noli Me Tangere', right: 'El Filibusterismo', contrast: 'Noli Me Tangere exposes social cancers through idealism and reformist dialogue, while El Filibusterismo takes a darker, politically charged tone examining failed reform and revolution' },
    ],
    sequences: [
      {
        title: 'How a bill becomes a law in the Philippines',
        steps: [
          'Filing and First Reading in either House or Senate, then committee referral',
          'Second Reading debate, amendments, and approval',
          'Third Reading final vote and bicameral reconciliation if versions differ',
          'Presidential approval (or veto override by two-thirds vote of both houses)',
        ],
      },
    ],
    workedExample: {
      title: 'Applying Judicial Review to a Challenged Ordinance',
      code: 'Actual case/controversy -> Constitutional challenge -> Supreme Court exercises Article VIII power to uphold or strike down',
      walkthrough: 'Courts cannot rewrite policy preferences, but must invalidate laws or acts showing grave abuse of discretion or violating constitutional rights.',
      takeaway: 'Checks and balances prevent concentration of power in any single branch.',
    },
    pitfalls: ['Confusing the 1935, 1973, and 1987 constitutions', 'Treating the Bill of Rights as restricting private disagreements instead of state action', 'Mixing up Noli Me Tangere and El Filibusterismo themes'],
  },
  {
    id: 'ethics',
    domain: 'Humanities & Philosophy',
    title: 'Applied Ethics & Critical Reasoning',
    triggers: ['ethics', 'utilitarianism', 'deontology', 'virtue ethics', 'moral dilemma', 'logical fallacy', 'bioethics', 'professional ethics'],
    objectives: [
      'Compare consequentialist, deontological, and virtue-ethics frameworks on real dilemmas',
      'Spot common informal logical fallacies in arguments',
      'Construct reasoned ethical justifications addressing stakeholder impact and duties',
    ],
    definitions: [
      { term: 'Utilitarianism', definition: 'an ethical framework judging actions right when they maximize overall net well-being across affected stakeholders' },
      { term: 'Deontology', definition: 'duty-based ethics holding that certain actions are intrinsically right or wrong regardless of their consequences' },
      { term: 'Virtue ethics', definition: 'a character-centered ethical tradition focusing on cultivating practical wisdom, integrity, and moral habits' },
      { term: 'Ad hominem fallacy', definition: 'attacking a speaker\'s personal traits rather than evaluating the logic or evidence of their argument' },
    ],
    facts: [
      { statement: 'Kant\'s categorical imperative forbids treating persons merely as means to an end, even when doing so might maximize aggregate utility.', misconception: 'Kantian deontology approves any deceptive act whenever it produces higher total happiness.', bloom: 'analyze' },
      { statement: 'Straw man reasoning misrepresents an opponent\'s position as weaker or more extreme to make it easier to refute.', misconception: 'Refuting a cited empirical study with stronger counter-evidence is an example of the straw man fallacy.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Utilitarianism', right: 'Deontology', contrast: 'Utilitarianism evaluates consequences (outcomes for all affected), whereas deontology evaluates adherence to moral duties and rights' },
    ],
    sequences: [
      {
        title: 'Ethical decision-making analysis',
        steps: [
          'Clarify the facts, affected stakeholders, and competing values',
          'Evaluate available options using duty, consequence, and character lenses',
          'Select a defensible course of action and plan mitigation for harms',
        ],
      },
    ],
    workedExample: {
      title: 'Analyzing Data Privacy vs Feature Personalization',
      code: 'Utilitarian check: convenience vs breach harm\nDeontological check: informed consent & non-deception duty',
      walkthrough: 'Even if collecting undisclosed behavioral data helps product metrics, deontology rejects violating informed consent.',
      takeaway: 'Multi-framework ethical review surfaces blind spots before deployment.',
    },
    pitfalls: ['Equating ethics solely with personal preference or legal minimum', 'Confusing correlation fallacies with ad hominem attacks', 'Ignoring minority harm under naive utilitarian calculations'],
  },
  {
    id: 'nursing-health',
    domain: 'Health Sciences & Nursing',
    title: 'Foundations of Nursing & Infection Control',
    triggers: ['nursing', 'nursing process', 'adpie', 'vital signs', 'infection control', 'asepsis', 'hand hygiene', 'patient safety', 'clinical'],
    objectives: [
      'Apply the five-step ADPIE nursing process systematically in patient care',
      'Select appropriate hand hygiene, standard precautions, and transmission-based isolation',
      'Recognize normal adult vital sign baselines and red-flag deviations',
    ],
    definitions: [
      { term: 'ADPIE (Nursing Process)', definition: 'the five-phase clinical framework: Assessment, Diagnosis, Planning, Implementation, and Evaluation' },
      { term: 'Standard precautions', definition: 'baseline infection-prevention practices applied to all patients regardless of confirmed infection status' },
      { term: 'Medical asepsis', definition: 'clean technique aimed at reducing pathogens and preventing cross-transmission between patients and environments' },
      { term: 'Surgical asepsis', definition: 'sterile technique eliminating all microorganisms and spores for invasive procedures' },
    ],
    facts: [
      { statement: 'Soap and water handwashing—not alcohol hand rub—is required after caring for patients with spore-forming Clostridioides difficile or visibly soiled hands.', misconception: 'Alcohol-based hand sanitizer destroys bacterial spores more effectively than soap and running water.', bloom: 'apply' },
      { statement: 'Assessment always precedes nursing diagnosis and intervention so care plans address verified patient data.', misconception: 'Evaluation occurs before initial assessment when prioritizing acute patient needs.', bloom: 'understand' },
    ],
    comparisons: [
      { left: 'Medical asepsis (clean)', right: 'Surgical asepsis (sterile)', contrast: 'Medical asepsis reduces pathogen counts in routine care, whereas surgical asepsis eliminates all microorganisms including spores' },
    ],
    sequences: [
      {
        title: 'Five phases of the ADPIE nursing process',
        steps: [
          'Assessment: gather subjective and objective patient data',
          'Diagnosis: identify clinical patient responses and priorities',
          'Planning: establish measurable, time-bound patient goals',
          'Implementation: perform safe evidence-based interventions',
          'Evaluation: measure goal attainment and revise the care plan',
        ],
      },
    ],
    workedExample: {
      title: 'Responding to Post-Operative Tachypnea & SpO2 Drop',
      code: 'Assess airway/vitals -> Sit patient upright if safe & apply prescribed O2 -> Re-evaluate SpO2 & escalate',
      walkthrough: 'Prioritizing immediate airway/breathing assessment before documentation prevents missed deterioration.',
      takeaway: 'Re-assess after every intervention to verify clinical improvement.',
    },
    pitfalls: ['Using alcohol rub on visibly soiled or C. diff exposure hands', 'Jumping to implementation before assessment', 'Confusing clean vs sterile field rules'],
  },
  {
    id: 'programming-basics',
    domain: 'Computer Science',
    title: 'Programming Fundamentals & Control Flow',
    triggers: ['programming', 'control flow', 'loops', 'for loop', 'while loop', 'conditional', 'if else', 'functions', 'scope', 'debugging', 'python', 'javascript'],
    objectives: [
      'Trace conditional branching and definite vs indefinite loops accurately',
      'Decompose repetitive logic into pure, well-scoped functions with parameters and return values',
      'Diagnose syntax, runtime, and logic errors systematically using test cases',
    ],
    definitions: [
      { term: 'Variable scope', definition: 'the region of code where a declared variable is visible and can be accessed safely' },
      { term: 'For loop', definition: 'a definite iteration construct typically used when traversing a sequence or fixed range of items' },
      { term: 'While loop', definition: 'an indefinite loop repeating while a boolean condition remains true, requiring progress toward termination' },
      { term: 'Logic error', definition: 'a bug where code runs without crashing but computes the wrong output due to flawed conditions or formulas' },
    ],
    facts: [
      { statement: 'Returning a value from a function passes data back to the caller for reuse, whereas printing displays text to stdout and returns None/undefined.', misconception: 'Printing a value inside a function automatically assigns that value to the caller variable.', bloom: 'apply' },
      { statement: 'If a while-loop condition never becomes false and no break occurs, the program enters an infinite loop.', misconception: 'Every while loop automatically stops after iterating once through all declared variables.', bloom: 'understand' },
    ],
    comparisons: [
      { left: 'return statement', right: 'print statement', contrast: 'return hands a computed value back to calling code and exits the function, while print writes output to the console' },
      { left: 'Syntax error', right: 'Logic error', contrast: 'Syntax errors violate language grammar before execution starts, whereas logic errors execute cleanly but yield incorrect answers' },
    ],
    sequences: [
      {
        title: 'Systematic debugging workflow',
        steps: [
          'Reproduce the failure consistently with a minimal input',
          'Inspect actual intermediate state near the failing assumption',
          'Fix the root cause rather than masking symptoms',
          'Add regression test cases covering normal and boundary inputs',
        ],
      },
    ],
    workedExample: {
      title: 'Off-by-One Loop Boundary Check',
      code: 'for (let i = 0; i < arr.length; i++) { ... } // visits indices 0..length-1',
      walkthrough: 'Using <= arr.length accesses index arr.length which is undefined (or throws IndexError in Python).',
      takeaway: 'Always check first, last, and empty inputs when verifying loops.',
    },
    pitfalls: ['Using = (assignment) instead of ==/=== (comparison)', 'Mutating lists while iterating over them', 'Using print instead of return in helper functions'],
  },
  {
    id: 'management-marketing',
    domain: 'Business & Management',
    title: 'Management, Strategy & Marketing Mix',
    triggers: ['management', 'swot', 'marketing mix', '4ps', 'entrepreneurship', 'strategic planning', 'agile', 'scrum', 'project management', 'leadership'],
    objectives: [
      'Conduct an internal/external SWOT analysis linking organizational capabilities to market trends',
      'Align Product, Price, Place, and Promotion decisions to a target segment',
      'Apply iterative project planning, risk control, and team leadership frameworks',
    ],
    definitions: [
      { term: 'SWOT analysis', definition: 'a strategic matrix separating internal Strengths and Weaknesses from external Opportunities and Threats' },
      { term: 'Marketing mix (4Ps)', definition: 'the coordinated tactical choices of Product, Price, Place (distribution), and Promotion for a target market' },
      { term: 'Value proposition', definition: 'a clear statement explaining why target customers gain distinct benefits from an offering compared to alternatives' },
      { term: 'Agile sprint', definition: 'a short time-boxed iteration focused on delivering a tested, usable product increment' },
    ],
    facts: [
      { statement: 'In SWOT analysis, Strengths and Weaknesses are internal organizational factors, whereas Opportunities and Threats come from the external environment.', misconception: 'Competitor price cuts and regulatory changes are classified as internal organizational Weaknesses in SWOT.', bloom: 'understand' },
      { statement: 'In the 4Ps marketing mix, Place covers distribution channels and accessibility to customers—not merely physical store decoration.', misconception: 'Promotion in the 4Ps refers strictly to discounting prices rather than communicating product value.', bloom: 'apply' },
    ],
    comparisons: [
      { left: 'Internal factors (S/W)', right: 'External factors (O/T)', contrast: 'Strengths and Weaknesses lie within organizational control, while Opportunities and Threats arise from external market, legal, or economic forces' },
    ],
    sequences: [
      {
        title: 'Strategic planning cycle',
        steps: [
          'Define mission, measurable objectives, and target customer segment',
          'Assess internal strengths/weaknesses and external opportunities/threats',
          'Formulate actionable strategy, budget, and 4Ps execution plan',
          'Track KPIs and adapt tactics based on market feedback',
        ],
      },
    ],
    workedExample: {
      title: 'Classifying SWOT Factors for a Local Bakery',
      code: 'Strength: High-margin signature recipes\nOpportunity: Rising university foot traffic\nThreat: Rising flour import costs',
      walkthrough: 'Separating controllable internal items from uncontrollable external trends keeps action plans realistic.',
      takeaway: 'Every SWOT matrix should end with concrete actions pairing Strengths with Opportunities.',
    },
    pitfalls: ['Mixing internal weaknesses with external threats in SWOT', 'Setting vague unmeasurable goals instead of SMART targets', 'Designing promotions without identifying a target audience'],
  },
];

const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s/-]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Score and return up to 2 best-matching curriculum knowledge packs for a topic/material text.
 * Uses whole-phrase / whole-word matching to prevent false positives (e.g., "c" or "sql" inside unrelated words).
 */
export function matchKnowledge(text) {
  const hay = ` ${normalize(text)} `;
  if (hay.trim().length < 2) return [];
  const scored = [];
  for (const pack of PACKS) {
    let score = 0;
    for (const trig of pack.triggers) {
      const t = normalize(trig);
      if (!t) continue;
      if (hay.includes(` ${t} `)) {
        score += t.includes(' ') ? 6 : 3;
      }
    }
    if (score >= 3) scored.push({ pack, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((s) => s.pack);
}

export function listKnowledgeDomains() {
  return PACKS.map((p) => ({ id: p.id, title: p.title, domain: p.domain }));
}
