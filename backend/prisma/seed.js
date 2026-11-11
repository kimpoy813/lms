// Database seed.
//
//   npm run db:seed
//
// Always (safe to re-run, also in production):
//   • permission catalogue, default grading scale
//   • the first administrator, when SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are set and no
//     administrator exists yet (the account must change its password at first sign-in)
//
// Outside production only: a demo school — accounts flagged isDemo (they cannot sign in when
// NODE_ENV=production), classes, lessons, assignments, quizzes, attendance and grades.
// The demo content is created through the real HTTP API (in-process), so it obeys every business
// rule (gradebook sync, question snapshots, notifications…), and is then back-dated.
process.env.SCHEDULER_ENABLED = 'false';
process.env.LOG_LEVEL ??= 'warn';

const { env } = await import('../src/config/env.js');
const { prisma, disconnect } = await import('../src/db/prisma.js');
const { hashPassword, passwordPolicyError } = await import('../src/lib/password.js');
const { syncPermissionCatalog } = await import('../src/services/permissions.js');
const { ensureStorage } = await import('../src/services/storage.js');

const DEMO_PASSWORD = 'Demo-Pass-2026';
const DEMO_DOMAIN = 'edusphere.demo';
const warnings = [];
const log = (msg) => console.log(`  ${msg}`);

async function essentials() {
  await ensureStorage();
  await syncPermissionCatalog();
  if (!(await prisma.gradingScale.findFirst({ where: { isDefault: true } }))) {
    const bands = [
      [97, '1.00', 'Excellent'], [94, '1.25', 'Very Good'], [91, '1.50', 'Very Good'], [88, '1.75', 'Good'], [85, '2.00', 'Good'],
      [82, '2.25', 'Satisfactory'], [79, '2.50', 'Satisfactory'], [76, '2.75', 'Fair'], [75, '3.00', 'Passed'],
    ];
    await prisma.gradingScale.create({
      data: {
        name: 'Collegiate 1.00–5.00', description: 'Numeric college grading system (1.00 highest, 3.00 passing, 5.00 failed).', isDefault: true,
        entries: { create: [...bands.map(([minPercent, label, remark]) => ({ minPercent, label, remark, isPassing: true })), { minPercent: 0, label: '5.00', remark: 'Failed', isPassing: false }] },
      },
    });
    log('created the default grading scale');
  }
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password && (await prisma.user.count({ where: { role: 'ADMIN', isDemo: false } })) === 0) {
    const problem = passwordPolicyError(password, { email });
    if (problem) throw new Error(`SEED_ADMIN_PASSWORD is not acceptable: ${problem}`);
    await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'ADMIN', status: 'ACTIVE', firstName: 'System', lastName: 'Administrator', emailVerifiedAt: new Date(), mustChangePassword: true } });
    log(`created the administrator ${email} (must change the password at first sign-in)`);
  }
}

// ── A minimal signed-in HTTP client (cookie + CSRF token), like the web app ───
function client(base) {
  let cookie = '';
  let csrf = '';
  const call = async (method, path, body, { form } = {}) => {
    const headers = { origin: base, ...(cookie ? { cookie } : {}), ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}) };
    if (body !== undefined && !form) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}/api${path}`, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith('es_sid=')) cookie = c.split(';')[0];
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 400)}`);
    return json.data;
  };
  return {
    async login(email) {
      const data = await call('POST', '/auth/login', { email, password: DEMO_PASSWORD });
      csrf = data.csrfToken;
      this.user = data.user;
      return this;
    },
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b = {}) => call('PUT', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    delete: (p) => call('DELETE', p),
    async upload(name, content, type = 'text/plain') {
      const form = new FormData();
      form.append('files', new Blob([content], { type }), name);
      return (await call('POST', '/files', undefined, { form }))[0];
    },
  };
}

const DAY = 86_400_000;
const ago = (days, hours = 0) => new Date(Date.now() - days * DAY - hours * 3_600_000);
const ahead = (days, hours = 0) => new Date(Date.now() + days * DAY + hours * 3_600_000);

async function step(name, fn) {
  try {
    await fn();
    log(`✓ ${name}`);
  } catch (err) {
    warnings.push(`${name}: ${err.message}`);
    console.warn(`  ✗ ${name}: ${err.message}`);
  }
}

async function demo() {
  if (await prisma.user.findUnique({ where: { email: `admin@${DEMO_DOMAIN}` } })) {
    log('demo data already exists — nothing to do (run "npm run db:reset" to start again from an empty database)');
    return false;
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const now = new Date();

  // ── Catalogue ──────────────────────────────────────────────────────────────
  const dept = await prisma.department.create({ data: { code: 'CCS', name: 'College of Computer Studies' } });
  const gen = await prisma.department.create({ data: { code: 'CAS', name: 'College of Arts and Sciences' } });
  const bsit = await prisma.academicProgram.create({ data: { code: 'BSIT', name: 'Bachelor of Science in Information Technology', departmentId: dept.id, durationYears: 4 } });
  const bscs = await prisma.academicProgram.create({ data: { code: 'BSCS', name: 'Bachelor of Science in Computer Science', departmentId: dept.id, durationYears: 4 } });
  const year = await prisma.academicYear.create({ data: { name: 'AY 2026–2027', startDate: new Date('2026-08-01'), endDate: new Date('2027-05-31'), isCurrent: true } });
  const semester = await prisma.semester.create({ data: { academicYearId: year.id, name: 'First Semester', startDate: new Date('2026-08-03'), endDate: new Date('2026-12-18'), isCurrent: true } });
  await prisma.semester.create({ data: { academicYearId: year.id, name: 'Second Semester', startDate: new Date('2027-01-11'), endDate: new Date('2027-05-28') } });
  const courses = {};
  for (const [code, title, departmentId] of [['IT 101', 'Introduction to Computing', dept.id], ['CS 201', 'Data Structures and Algorithms', dept.id], ['GE 105', 'Purposive Communication', gen.id], ['IT 205', 'Web Systems and Technologies', dept.id]]) {
    courses[code] = await prisma.course.create({ data: { code, title, units: 3, departmentId } });
  }
  const sections = {};
  for (const [name, programId, yearLevel] of [['BSIT 1A', bsit.id, 1], ['BSIT 1B', bsit.id, 1], ['BSCS 2A', bscs.id, 2]]) {
    sections[name] = await prisma.section.create({ data: { name, programId, yearLevel } });
  }

  // ── People ─────────────────────────────────────────────────────────────────
  const base = { passwordHash, status: 'ACTIVE', emailVerifiedAt: now, isDemo: true };
  await prisma.user.create({ data: { ...base, email: `admin@${DEMO_DOMAIN}`, role: 'ADMIN', firstName: 'Andrea', lastName: 'Villanueva' } });
  await prisma.user.create({
    data: { ...base, email: `teacher@${DEMO_DOMAIN}`, role: 'TEACHER', firstName: 'Maria', lastName: 'Santos', teacherProfile: { create: { employeeNumber: 'EMP-2015-014', departmentId: dept.id, position: 'Assistant Professor', specialization: 'Software Engineering', consultationHours: 'Tue & Thu, 3:00–5:00 PM, CCS Faculty Room' } } },
  });
  await prisma.user.create({
    data: { ...base, email: `teacher2@${DEMO_DOMAIN}`, role: 'TEACHER', firstName: 'Jose', lastName: 'Reyes', teacherProfile: { create: { employeeNumber: 'EMP-2018-031', departmentId: gen.id, position: 'Instructor', specialization: 'English and Communication' } } },
  });
  const names = [
    ['Juan', 'Dela Cruz'], ['Angelica', 'Ramos'], ['Mark', 'Bautista'], ['Kristine', 'Garcia'], ['Paolo', 'Mendoza'],
    ['Bea', 'Flores'], ['Carlo', 'Aquino'], ['Nicole', 'Torres'], ['Miguel', 'Castillo'], ['Sofia', 'Navarro'],
  ];
  const studentRows = [];
  for (const [i, [firstName, lastName]] of names.entries()) {
    const second = i >= 7;
    studentRows.push(await prisma.user.create({
      data: {
        ...base, email: i === 0 ? `student@${DEMO_DOMAIN}` : `student${i + 1}@${DEMO_DOMAIN}`, role: 'STUDENT', firstName, lastName,
        studentProfile: { create: { studentNumber: `2026-${String(1001 + i).padStart(5, '0')}`, programId: second ? bscs.id : bsit.id, sectionId: (second ? sections['BSCS 2A'] : sections['BSIT 1A']).id, yearLevel: second ? 2 : 1 } },
      },
    }));
  }
  // One account waiting for approval, for the administrator's dashboard.
  await prisma.user.create({ data: { ...base, isDemo: true, status: 'PENDING', email: `pending.teacher@${DEMO_DOMAIN}`, role: 'TEACHER', firstName: 'Liza', lastName: 'Domingo', teacherProfile: { create: {} } } });
  log(`created ${names.length} students, 2 teachers and an administrator`);

  // ── The API, in-process ────────────────────────────────────────────────────
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const admin = await client(url).login(`admin@${DEMO_DOMAIN}`);
    const teacher = await client(url).login(`teacher@${DEMO_DOMAIN}`);
    const teacher2 = await client(url).login(`teacher2@${DEMO_DOMAIN}`);
    const students = [];
    for (const row of studentRows) students.push(await client(url).login(row.email));

    // Classes
    const it101 = await teacher.post('/classes', {
      courseId: courses['IT 101'].id, sectionId: sections['BSIT 1A'].id, semesterId: semester.id, room: 'Room 204', color: 'indigo',
      description: 'Fundamentals of computers, number systems, algorithms and the responsible use of technology.',
      schedules: [1, 3, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '10:00', room: 'Room 204' })),
    });
    const cs201 = await teacher.post('/classes', {
      courseId: courses['CS 201'].id, sectionId: sections['BSCS 2A'].id, semesterId: semester.id, room: 'Computer Lab 2', color: 'emerald', enrollmentRequiresApproval: true,
      description: 'Arrays, linked lists, stacks, queues, trees, sorting and searching, with an introduction to complexity analysis.',
      schedules: [2, 4].map((dayOfWeek) => ({ dayOfWeek, startTime: '13:00', endTime: '14:30', room: 'Computer Lab 2' })),
    });
    const ge105 = await teacher2.post('/classes', {
      courseId: courses['GE 105'].id, sectionId: sections['BSIT 1A'].id, semesterId: semester.id, room: 'Room 310', color: 'amber',
      description: 'Writing, speaking and presenting for different audiences and purposes.',
      schedules: [2, 4].map((dayOfWeek) => ({ dayOfWeek, startTime: '10:00', endTime: '11:30', room: 'Room 310' })),
    });
    const enrol = (classId, list, status = 'ENROLLED') => prisma.enrollment.createMany({ data: list.map((s) => ({ classId, studentId: s.user.id, status, source: 'ADMIN', enrolledAt: status === 'ENROLLED' ? ago(60) : null, requestedAt: ago(status === 'ENROLLED' ? 61 : 1) })) });
    const itStudents = students.slice(0, 8);
    await enrol(it101.id, itStudents);
    await enrol(ge105.id, students.slice(0, 6));
    await enrol(cs201.id, students.slice(7, 10));
    await enrol(cs201.id, [students[4]], 'PENDING');
    await prisma.enrollment.updateMany({ where: { classId: cs201.id, status: 'PENDING' }, data: { source: 'CODE' } });
    log('created 3 classes and enrolled the students');

    const cat = async (classId, kind, periodIndex = 0) => {
      const periods = await prisma.gradingPeriod.findMany({ where: { classId }, orderBy: { position: 'asc' }, include: { categories: true } });
      return periods[periodIndex].categories.find((c) => c.kind === kind).id;
    };

    // ── Learning content ───────────────────────────────────────────────────
    let module1;
    let module2;
    await step('modules and lessons', async () => {
      module1 = await teacher.post(`/classes/${it101.id}/modules`, { title: 'Module 1 — Introduction to Computers', description: 'What a computer is, how it evolved, and what it is made of.', objectives: ['Describe the generations of computers', 'Identify the main hardware components', 'Differentiate system software from application software'], status: 'PUBLISHED' });
      const lessons1 = [
        ['What is a computer?', 15, '<h3>Definition</h3><p>A <strong>computer</strong> is an electronic device that accepts data (input), processes it according to instructions (a program), produces information (output) and stores the results for later use.</p><h3>The IPOS cycle</h3><ol><li><strong>Input</strong> — data enters through devices such as the keyboard, mouse or microphone.</li><li><strong>Process</strong> — the CPU performs calculations and comparisons.</li><li><strong>Output</strong> — results appear on the monitor, printer or speakers.</li><li><strong>Storage</strong> — data is kept in memory and on drives.</li></ol><blockquote><p>Think of a sari-sari store calculator: you key in prices (input), it adds them (process) and shows the total (output).</p></blockquote>'],
        ['A short history of computing', 20, '<h3>Five generations</h3><table><tr><th>Generation</th><th>Technology</th><th>Example</th></tr><tr><td>First (1940s–50s)</td><td>Vacuum tubes</td><td>ENIAC</td></tr><tr><td>Second (1950s–60s)</td><td>Transistors</td><td>IBM 1401</td></tr><tr><td>Third (1960s–70s)</td><td>Integrated circuits</td><td>IBM System/360</td></tr><tr><td>Fourth (1970s–today)</td><td>Microprocessors</td><td>Personal computers</td></tr><tr><td>Fifth (today and beyond)</td><td>AI and parallel processing</td><td>Smart assistants</td></tr></table><p>Each generation made computers <em>smaller, faster, cheaper and more reliable</em> than the one before.</p>'],
        ['Hardware and software', 20, '<h3>Hardware</h3><p>The physical parts you can touch: the <strong>CPU</strong>, <strong>memory (RAM)</strong>, <strong>storage</strong>, and <strong>input/output devices</strong>.</p><h3>Software</h3><ul><li><strong>System software</strong> manages the hardware — for example Windows, Linux and Android.</li><li><strong>Application software</strong> helps people do tasks — for example word processors, browsers and games.</li></ul><p>Hardware without software cannot do anything useful; software without hardware cannot run.</p>'],
      ];
      module1.lessons = [];
      for (const [title, estimatedMinutes, contentHtml] of lessons1) module1.lessons.push(await teacher.post(`/modules/${module1.id}/lessons`, { title, estimatedMinutes, contentHtml }));
      module2 = await teacher.post(`/classes/${it101.id}/modules`, { title: 'Module 2 — Number Systems', description: 'Binary, octal, decimal and hexadecimal, and how to convert between them.', objectives: ['Convert numbers between bases 2, 8, 10 and 16', 'Explain why computers use binary'], status: 'PUBLISHED', prerequisiteModuleId: module1.id });
      module2.lessons = [];
      for (const [title, estimatedMinutes, contentHtml] of [
        ['Why binary?', 10, '<p>Digital circuits have two stable states — <strong>on</strong> and <strong>off</strong> — so computers represent everything with two digits: <code>1</code> and <code>0</code>. One binary digit is a <strong>bit</strong>; eight bits make a <strong>byte</strong>.</p>'],
        ['Decimal to binary conversion', 25, '<h3>Repeated division by 2</h3><p>Divide the number by 2 and write down the remainder. Repeat with the quotient until it becomes 0, then read the remainders from bottom to top.</p><pre><code>25 ÷ 2 = 12 remainder 1\n12 ÷ 2 =  6 remainder 0\n 6 ÷ 2 =  3 remainder 0\n 3 ÷ 2 =  1 remainder 1\n 1 ÷ 2 =  0 remainder 1\n\n25 (base 10) = 11001 (base 2)</code></pre>'],
        ['Hexadecimal', 20, '<p>Hexadecimal (base 16) uses the digits <code>0–9</code> and the letters <code>A–F</code>. One hex digit stands for exactly four bits, which makes long binary values easier to read: <code>1111 1111</code> is <code>FF</code>.</p>'],
      ]) module2.lessons.push(await teacher.post(`/modules/${module2.id}/lessons`, { title, estimatedMinutes, contentHtml }));
      await teacher.post(`/classes/${it101.id}/modules`, { title: 'Module 3 — Algorithms and Flowcharts', description: 'Still being prepared.', status: 'DRAFT' });
      await teacher.post(`/classes/${it101.id}/resources`, { title: 'Computer History Museum — Timeline of Computer History', description: 'Interactive timeline, useful for Activity 1.', type: 'LINK', url: 'https://www.computerhistory.org/timeline/', moduleId: module1.id });
      const m = await teacher.post(`/classes/${cs201.id}/modules`, { title: 'Week 1 — Arrays and Complexity', description: 'Static arrays, traversal, and Big-O notation.', status: 'PUBLISHED' });
      await teacher.post(`/modules/${m.id}/lessons`, { title: 'Big-O in ten minutes', estimatedMinutes: 10, contentHtml: '<p>Big-O describes how the running time of an algorithm grows as the input grows. Looking up <code>a[i]</code> is <strong>O(1)</strong>; scanning the whole array is <strong>O(n)</strong>; comparing every pair is <strong>O(n²)</strong>.</p>' });
      const g = await teacher2.post(`/classes/${ge105.id}/modules`, { title: 'Unit 1 — Communication Processes and Principles', status: 'PUBLISHED' });
      await teacher2.post(`/modules/${g.id}/lessons`, { title: 'Elements of communication', estimatedMinutes: 15, contentHtml: '<p>Every act of communication has a <strong>sender</strong>, a <strong>message</strong>, a <strong>channel</strong>, a <strong>receiver</strong>, <strong>feedback</strong> and a <strong>context</strong>. <em>Noise</em> is anything that distorts the message.</p>' });
    });
    await step('lesson progress', async () => {
      const done = [6, 6, 5, 4, 6, 3, 1, 2];
      const all = [...module1.lessons, ...module2.lessons];
      for (const [i, s] of itStudents.entries()) for (const lesson of all.slice(0, done[i])) await s.post(`/lessons/${lesson.id}/complete`);
    });

    // ── Announcements ──────────────────────────────────────────────────────
    await step('announcements', async () => {
      await admin.post('/announcements', { title: 'Midterm examination week: November 23–27', contentHtml: '<p>Midterm examinations for the First Semester run from <strong>November 23 to 27</strong>. Please settle your examination permits at the Registrar on or before November 20.</p>', priority: 'HIGH' });
      const welcome = await teacher.post('/announcements', { classId: it101.id, title: 'Welcome to IT 101!', contentHtml: '<p>Welcome, BSIT 1A! Lessons, activities and quizzes for this course are posted here. Please read the syllabus and finish <strong>Module 1</strong> this week.</p>', isPinned: true, allowComments: true });
      await students[1].post(`/announcements/${welcome.id}/comments`, { body: 'Thank you po, Ma\'am! Excited for this subject.' });
      await teacher.post('/announcements', { classId: it101.id, title: 'Quiz 2 is now open', contentHtml: '<p>Quiz 2 covers <em>Number Systems</em>. You have 20 minutes and two attempts; the higher score counts. It closes in five days.</p>', priority: 'HIGH' });
      await teacher.post('/announcements', { classId: cs201.id, title: 'Bring your laptops on Thursday', contentHtml: '<p>We will have a hands-on session on array operations. Install Python 3 before class.</p>' });
      await teacher2.post('/announcements', { classId: ge105.id, title: 'Speech outlines due next week', contentHtml: '<p>Submit your informative speech outline before our next meeting.</p>' });
      await prisma.announcement.updateMany({ where: { title: 'Welcome to IT 101!' }, data: { publishedAt: ago(58), createdAt: ago(58) } });
    });

    // ── Assignments ────────────────────────────────────────────────────────
    await step('assignments, submissions and grading', async () => {
      const assignmentCat = await cat(it101.id, 'ASSIGNMENT');
      const rubric = await teacher.post('/rubrics', {
        title: 'Reflection essay rubric',
        criteria: [
          { title: 'Content and insight', maxPoints: 20, levels: [{ title: 'Excellent', points: 20, description: 'Specific, thoughtful examples' }, { title: 'Good', points: 16 }, { title: 'Fair', points: 12 }, { title: 'Needs work', points: 6 }] },
          { title: 'Organisation', maxPoints: 15, levels: [{ title: 'Excellent', points: 15 }, { title: 'Good', points: 12 }, { title: 'Fair', points: 9 }, { title: 'Needs work', points: 5 }] },
          { title: 'Grammar and mechanics', maxPoints: 15, levels: [{ title: 'Excellent', points: 15 }, { title: 'Good', points: 12 }, { title: 'Fair', points: 9 }, { title: 'Needs work', points: 5 }] },
        ],
      });
      // Activity 1: handed in, graded and returned last week.
      const a1 = await teacher.post(`/classes/${it101.id}/assignments`, { title: 'Activity 1: History of Computing Timeline', instructionsHtml: '<p>Create a timeline with <strong>at least eight</strong> milestones in the history of computing. For each milestone, write the year, the invention and one sentence on why it mattered.</p>', points: 50, dueAt: ahead(1), status: 'PUBLISHED', categoryId: assignmentCat, moduleId: module1.id });
      const scores1 = [47, 44, 39, 46, 35, 42, null, 30];
      for (const [i, s] of itStudents.entries()) {
        if (scores1[i] === null) continue;
        await s.put(`/assignments/${a1.id}/submission`, { textContent: '<p>1946 — ENIAC, the first general-purpose electronic computer. 1947 — the transistor replaces vacuum tubes. 1958 — the integrated circuit. 1971 — the Intel 4004 microprocessor. 1981 — the IBM PC. 1989 — the World Wide Web. 2007 — the first iPhone. 2022 — generative AI reaches the public.</p>', submit: true });
        await teacher.put(`/assignments/${a1.id}/submissions/${s.user.id}/grade`, { score: scores1[i], feedback: scores1[i] >= 44 ? 'Complete and well explained. Good work!' : 'Good start — add why each milestone mattered.' });
      }
      await teacher.post(`/assignments/${a1.id}/return`, {});
      await prisma.assignment.update({ where: { id: a1.id }, data: { dueAt: ago(9), createdAt: ago(16), publishedAt: ago(16) } });
      await prisma.assignmentSubmission.updateMany({ where: { assignmentId: a1.id }, data: { submittedAt: ago(10), gradedAt: ago(7), returnedAt: ago(7) } });

      // Activity 2: due yesterday, waiting to be graded; two students have not submitted.
      const a2 = await teacher.post(`/classes/${it101.id}/assignments`, { title: 'Activity 2: Number System Conversion Worksheet', instructionsHtml: '<p>Convert the following and <strong>show your solution</strong>:</p><ol><li>45 (base 10) to binary</li><li>101101 (base 2) to decimal</li><li>255 (base 10) to hexadecimal</li><li>7F (base 16) to binary</li></ol>', points: 40, dueAt: ahead(1), status: 'PUBLISHED', categoryId: assignmentCat, moduleId: module2.id, latePenaltyType: 'PERCENT_PER_DAY', latePenaltyValue: 5, latePenaltyMax: 30 });
      for (const i of [0, 1, 2, 3, 4, 5]) await itStudents[i].put(`/assignments/${a2.id}/submission`, { textContent: '<p>1) 101101&nbsp; 2) 45&nbsp; 3) FF&nbsp; 4) 0111 1111 — solutions attached in my notebook photo.</p>', submit: true });
      await prisma.assignment.update({ where: { id: a2.id }, data: { dueAt: ago(1), createdAt: ago(8), publishedAt: ago(8) } });
      await prisma.assignmentSubmission.updateMany({ where: { assignmentId: a2.id }, data: { submittedAt: ago(2) } });
      await prisma.assignmentSubmission.updateMany({ where: { assignmentId: a2.id, studentId: itStudents[5].user.id }, data: { submittedAt: ago(0, 6), isLate: true } });

      // Reflection essay: due in four days, graded with the rubric.
      const a3 = await teacher.post(`/classes/${it101.id}/assignments`, { title: 'Reflection Essay: Computers in My Daily Life', instructionsHtml: '<p>In 300–500 words, describe three ways computers affect your daily life and reflect on one risk of depending on them. Your essay is graded with the attached rubric.</p>', dueAt: ahead(4), status: 'PUBLISHED', categoryId: assignmentCat, rubricId: rubric.id });
      await itStudents[1].put(`/assignments/${a3.id}/submission`, { textContent: '<p>Every morning my phone wakes me up, tells me the weather and shows me my class schedule…</p>', submit: true });
      await itStudents[0].put(`/assignments/${a3.id}/submission`, { textContent: '<p>Draft: I use computers for school, for talking to my family abroad, and for…</p>', submit: false });
      await teacher.post(`/classes/${it101.id}/assignments`, { title: 'Activity 3: Flowchart of a Daily Routine', instructionsHtml: '<p>Draw a flowchart with at least one decision symbol.</p>', points: 30, status: 'DRAFT' });
      await teacher2.post(`/classes/${ge105.id}/assignments`, { title: 'Informative Speech Outline', instructionsHtml: '<p>Submit a one-page outline of your informative speech: topic, purpose, three main points and your sources.</p>', points: 50, dueAt: ahead(6), status: 'PUBLISHED', categoryId: await cat(ge105.id, 'ASSIGNMENT') });
      await teacher.post(`/classes/${cs201.id}/assignments`, { title: 'Lab 1: Array Operations', instructionsHtml: '<p>Implement insert, delete and linear search on a static array. Submit your source file.</p>', points: 100, dueAt: ahead(3), status: 'PUBLISHED', categoryId: await cat(cs201.id, 'ASSIGNMENT') });
    });

    // ── Question bank and quizzes ──────────────────────────────────────────
    await step('question bank and quizzes', async () => {
      const bank = await teacher.post('/question-banks', { title: 'IT 101 — Midterm question bank', subject: 'Introduction to Computing' });
      const basics = [
        { type: 'MULTIPLE_CHOICE', topic: 'Hardware', difficulty: 'EASY', points: 2, text: '<p>Which part of the computer is known as its “brain”?</p>', choices: [{ text: 'RAM' }, { text: 'CPU', isCorrect: true }, { text: 'Hard disk' }, { text: 'Monitor' }], explanation: 'The central processing unit executes instructions.' },
        { type: 'TRUE_FALSE', topic: 'Software', difficulty: 'EASY', points: 1, text: '<p>An operating system is an example of application software.</p>', answer: false, explanation: 'It is system software.' },
        { type: 'IDENTIFICATION', topic: 'History', difficulty: 'MEDIUM', points: 2, text: '<p>What technology replaced vacuum tubes in second-generation computers?</p>', accepted: ['transistor', 'transistors'] },
        { type: 'MULTIPLE_RESPONSE', topic: 'Hardware', difficulty: 'MEDIUM', points: 2, text: '<p>Which of these are <strong>input</strong> devices?</p>', choices: [{ text: 'Keyboard', isCorrect: true }, { text: 'Printer' }, { text: 'Microphone', isCorrect: true }, { text: 'Speaker' }] },
        { type: 'MATCHING', topic: 'History', difficulty: 'MEDIUM', points: 3, text: '<p>Match each generation with its technology.</p>', pairs: [{ left: 'First generation', right: 'Vacuum tubes' }, { left: 'Third generation', right: 'Integrated circuits' }, { left: 'Fourth generation', right: 'Microprocessors' }] },
        { type: 'ESSAY', topic: 'Software', difficulty: 'HARD', points: 5, text: '<p>In three to five sentences, explain the difference between system software and application software. Give one example of each.</p>' },
      ];
      const numbers = [
        { type: 'MULTIPLE_CHOICE', topic: 'Number systems', difficulty: 'EASY', points: 2, text: '<p>What is 1010 (base 2) in decimal?</p>', choices: [{ text: '8' }, { text: '10', isCorrect: true }, { text: '12' }, { text: '5' }] },
        { type: 'IDENTIFICATION', topic: 'Number systems', difficulty: 'MEDIUM', points: 2, text: '<p>Convert 255 (base 10) to hexadecimal.</p>', accepted: ['FF', '0xFF'] },
        { type: 'FILL_BLANKS', topic: 'Number systems', difficulty: 'EASY', points: 2, text: '<p>One byte is made of ___ bits, and one hexadecimal digit stands for ___ bits.</p>', blanks: [['8', 'eight'], ['4', 'four']] },
        { type: 'ORDERING', topic: 'Number systems', difficulty: 'MEDIUM', points: 2, text: '<p>Arrange from the smallest to the largest value.</p>', items: ['101 (base 2)', '7 (base 10)', 'A (base 16)', '20 (base 8)'] },
        { type: 'TRUE_FALSE', topic: 'Number systems', difficulty: 'EASY', points: 1, text: '<p>The octal number system uses the digits 0 to 8.</p>', answer: false },
        { type: 'SHORT_ANSWER', topic: 'Number systems', difficulty: 'MEDIUM', points: 1, text: '<p>What is 13 (base 10) in binary?</p>', accepted: ['1101'] },
      ];
      const saved = await teacher.post(`/question-banks/${bank.id}/questions/bulk`, { questions: [...basics, ...numbers] });
      const quizCat = await cat(it101.id, 'QUIZ');
      const ids = saved.questionIds;

      // Quiz 1: closed three days ago, everyone but one student took it.
      const q1 = await teacher.post(`/classes/${it101.id}/quizzes`, { title: 'Quiz 1: Computer Basics', instructionsHtml: '<p>Covers Module 1. Answer all questions. The essay is checked by your teacher.</p>', categoryId: quizCat, moduleId: module1.id, resultVisibility: 'IMMEDIATE', answerVisibility: 'CORRECT_ANSWERS', timeLimitMinutes: 30 });
      await teacher.put(`/quizzes/${q1.id}/questions`, { items: ids.slice(0, 6).map((questionId, i) => ({ questionId, points: basics[i].points })) });
      await teacher.patch(`/quizzes/${q1.id}`, { status: 'PUBLISHED' });
      // How well each student answers: [cpu, os, transistor, inputs, matching, essay words, essay score]
      const skill = [[1, 1, 1, 1, 1, 5], [1, 1, 1, 1, 1, 4], [1, 0, 1, 1, 0, 3], [1, 1, 1, 0, 1, 5], [1, 0, 0, 1, 0, 2], [1, 1, 0, 1, 1, null], [0, 0, 0, 0, 0, null], null];
      for (const [i, s] of itStudents.entries()) {
        if (!skill[i]) continue;
        const { attemptId } = await s.post(`/quizzes/${q1.id}/attempts`);
        const attempt = await s.get(`/attempts/${attemptId}`);
        const k = skill[i];
        for (const item of attempt.questions) {
          const q = item.question;
          const pos = item.position;
          const pick = (text) => q.choices.find((c) => c.text === text)?.id;
          let response = null;
          if (q.type === 'MULTIPLE_CHOICE') response = { choiceId: pick(k[0] ? 'CPU' : 'RAM') };
          else if (q.type === 'TRUE_FALSE') response = { choiceId: pick(k[1] ? 'False' : 'True') };
          else if (q.type === 'IDENTIFICATION') response = { text: k[2] ? 'Transistors' : 'microchips' };
          else if (q.type === 'MULTIPLE_RESPONSE') response = { choiceIds: k[3] ? [pick('Keyboard'), pick('Microphone')] : [pick('Keyboard'), pick('Printer')] };
          else if (q.type === 'MATCHING') {
            const right = (label) => q.right.find((o) => o.text === label)?.id;
            const want = { 'First generation': 'Vacuum tubes', 'Third generation': 'Integrated circuits', 'Fourth generation': 'Microprocessors' };
            const pairs = {};
            for (const left of q.left) pairs[left.id] = right(k[4] ? want[left.text] : 'Vacuum tubes');
            response = { pairs };
          } else if (q.type === 'ESSAY') response = { text: 'System software such as Windows controls the hardware and lets other programs run. Application software such as a word processor helps the user finish a specific task. Without system software, applications cannot run.' };
          if (response) await s.put(`/attempts/${attemptId}/answers/${pos}`, { response });
        }
        await s.post(`/attempts/${attemptId}/submit`);
        if (k[5] !== null) {
          const essay = attempt.questions.find((x) => x.question.type === 'ESSAY');
          await teacher.put(`/attempts/${attemptId}/answers/${essay.position}/grade`, { score: k[5], feedback: k[5] >= 4 ? 'Clear explanation with correct examples.' : 'Give one example of each kind of software.' });
        }
      }
      await prisma.quiz.update({ where: { id: q1.id }, data: { availableFrom: ago(6), availableUntil: ago(3), createdAt: ago(8), publishedAt: ago(7) } });
      await prisma.quizAttempt.updateMany({ where: { quizId: q1.id }, data: { startedAt: ago(4, 1), submittedAt: ago(4) } });

      // Quiz 2: open now.
      const q2 = await teacher.post(`/classes/${it101.id}/quizzes`, { title: 'Quiz 2: Number Systems', instructionsHtml: '<p>Covers Module 2. You have <strong>20 minutes</strong> and two attempts; the higher score counts.</p>', categoryId: quizCat, moduleId: module2.id, resultVisibility: 'IMMEDIATE', answerVisibility: 'RESPONSES', timeLimitMinutes: 20, maxAttempts: 2, shuffleQuestions: true, shuffleChoices: true, availableUntil: ahead(5) });
      await teacher.put(`/quizzes/${q2.id}/questions`, { items: ids.slice(6).map((questionId, i) => ({ questionId, points: numbers[i].points })) });
      await teacher.patch(`/quizzes/${q2.id}`, { status: 'PUBLISHED' });

      // The midterm examination: prepared, opens next week.
      const exam = await teacher.post(`/classes/${it101.id}/quizzes`, { title: 'Midterm Examination', kind: 'EXAM', instructionsHtml: '<p>Covers Modules 1 and 2. One attempt only. Results are released by your teacher.</p>', categoryId: await cat(it101.id, 'EXAM'), resultVisibility: 'MANUAL', timeLimitMinutes: 60, availableFrom: ahead(12), availableUntil: ahead(12, 3), shuffleQuestions: true });
      await teacher.put(`/quizzes/${exam.id}/questions`, { items: ids.map((questionId, i) => ({ questionId, points: [...basics, ...numbers][i].points * 2 })) });
      await teacher.patch(`/quizzes/${exam.id}`, { status: 'PUBLISHED' });

      // A practice quiz in CS 201 drawn at random from a second bank.
      const bank2 = await teacher.post('/question-banks', { title: 'CS 201 — Complexity', subject: 'Data Structures' });
      await teacher.post(`/question-banks/${bank2.id}/questions/bulk`, {
        questions: [
          ['Accessing an array element by index', 'O(1)'], ['Linear search in an unsorted array', 'O(n)'], ['Binary search in a sorted array', 'O(log n)'], ['Bubble sort, worst case', 'O(n²)'], ['Merge sort', 'O(n log n)'],
        ].map(([what, answer]) => ({ type: 'MULTIPLE_CHOICE', topic: 'Big-O', points: 1, text: `<p>What is the time complexity of: ${what}?</p>`, choices: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n²)'].map((t) => ({ text: t, isCorrect: t === answer })) })),
      });
      const practice = await teacher.post(`/classes/${cs201.id}/quizzes`, { title: 'Practice: Big-O Warm-up', kind: 'PRACTICE', resultVisibility: 'IMMEDIATE', answerVisibility: 'CORRECT_ANSWERS', maxAttempts: 10 });
      await teacher.put(`/quizzes/${practice.id}/pools`, { pools: [{ bankId: bank2.id, topic: 'Big-O', count: 3, pointsEach: 1 }] });
      await teacher.patch(`/quizzes/${practice.id}`, { status: 'PUBLISHED' });
    });

    // ── Attendance ─────────────────────────────────────────────────────────
    await step('attendance', async () => {
      await teacher.post('/attendance/locations', { name: 'Room 204 — Main Building', latitude: 15.13325, longitude: 120.59012, defaultRadiusMeters: 50 });
      // P = present, L = late, A = absent, E = excused — one string per student, one letter per meeting.
      const pattern = ['PPPPPPPP', 'PPPLPPPP', 'PPAPPLPP', 'PPPPPPPE', 'PLPPAPPL', 'PPPPPPLP', 'AAPALAAP', 'PLLPLALP'];
      const letter = { P: 'PRESENT', L: 'LATE', A: 'ABSENT', E: 'EXCUSED' };
      const meetings = [23, 21, 18, 16, 14, 11, 9, 7];
      for (const [m, daysAgo] of meetings.entries()) {
        const session = await teacher.post(`/classes/${it101.id}/attendance/sessions`, { title: `Meeting ${m + 1}` });
        await teacher.put(`/attendance/sessions/${session.id}/records`, { records: itStudents.map((s, i) => ({ studentId: s.user.id, status: letter[pattern[i][m]], ...(pattern[i][m] === 'E' ? { remarks: 'Medical certificate submitted' } : {}) })), close: true });
        const start = ago(daysAgo);
        start.setUTCHours(1, 0, 0, 0); // 09:00 in Manila
        await prisma.attendanceSession.update({ where: { id: session.id }, data: { date: new Date(start.toISOString().slice(0, 10)), startTime: start, endTime: new Date(start.getTime() + 3_600_000), closedAt: new Date(start.getTime() + 3_600_000), createdAt: start } });
        await prisma.attendanceRecord.updateMany({ where: { sessionId: session.id }, data: { createdAt: new Date(start.getTime() + 5 * 60_000) } });
      }
      const s = await teacher.post(`/classes/${cs201.id}/attendance/sessions`, { title: 'Meeting 1' });
      await teacher.put(`/attendance/sessions/${s.id}/records`, { records: students.slice(7, 10).map((x) => ({ studentId: x.user.id, status: 'PRESENT' })), close: true });
    });

    // ── Gradebook ──────────────────────────────────────────────────────────
    await step('gradebook', async () => {
      const recitation = await teacher.post(`/classes/${it101.id}/gradebook/items`, { categoryId: await cat(it101.id, 'ACTIVITY'), title: 'Recitation 1', maxPoints: 20 });
      const scores = [19, 18, 15, 20, 12, 17, 8, 14];
      await teacher.put(`/classes/${it101.id}/gradebook/entries`, { entries: itStudents.map((s, i) => ({ itemId: recitation.id, studentId: s.user.id, status: 'GRADED', score: scores[i] })) });
    });
    await step('grade appeal and attendance correction', async () => {
      const book = await teacher.get(`/classes/${it101.id}/gradebook`);
      const quizItem = book.structure.periods.flatMap((p) => p.categories).flatMap((c) => c.items).find((i) => i.title.startsWith('Quiz 1'));
      await itStudents[2].post(`/classes/${it101.id}/gradebook/appeals`, { gradeItemId: quizItem?.id, reason: 'I answered “Operating system is system software” as False, which matches the key, but I think my matching item was also correct. Could you please recheck it po?' });
    });

    // ── Communication ──────────────────────────────────────────────────────
    await step('discussions and messages', async () => {
      const thread = await teacher.post(`/classes/${it101.id}/discussions`, { title: 'Introduce yourself!', topic: 'General', body: '<p>Tell us your name, where you are from, and the first computer or phone you ever used.</p>' });
      await teacher.patch(`/discussions/threads/${thread.id}`, { isPinned: true });
      const r = await itStudents[0].post(`/discussions/threads/${thread.id}/replies`, { body: '<p>Hi! I\'m Juan from Angeles City. My first computer was the family desktop we used for Friendster. 😄</p>' });
      await itStudents[3].post(`/discussions/threads/${thread.id}/replies`, { body: '<p>Hello everyone, Kristine here from Mabalacat. My first phone was a Nokia 3310!</p>' });
      await teacher.post(`/discussions/threads/${thread.id}/replies`, { body: '<p>Friendster! That brings back memories, Juan.</p>', parentReplyId: r.id });
      const question = await itStudents[4].post(`/classes/${it101.id}/discussions`, { title: 'How do I convert a decimal fraction to binary?', topic: 'Module 2', body: '<p>I understand whole numbers, but how about 0.625?</p>' });
      await itStudents[1].post(`/discussions/threads/${question.id}/replies`, { body: '<p>Multiply by 2 repeatedly and take the whole-number part each time: 0.625 → 1, 0.25 → 0, 0.5 → 1, so 0.101.</p>' });
      const conv = await itStudents[0].post('/messages/conversations', { userId: teacher.user.id });
      await itStudents[0].post(`/messages/conversations/${conv.id}/messages`, { body: 'Good afternoon po, Ma\'am Santos. May I ask if Activity 2 can be handwritten and submitted as a photo?' });
      await teacher.post(`/messages/conversations/${conv.id}/messages`, { body: 'Yes, Juan. A clear photo or a scanned PDF is fine. Make sure your solutions are readable.' });
      await itStudents[0].post(`/messages/conversations/${conv.id}/messages`, { body: 'Thank you po!' });
      const conv2 = await teacher.post('/messages/conversations', { userId: itStudents[6].user.id });
      await teacher.post(`/messages/conversations/${conv2.id}/messages`, { body: 'Hi Carlo, I noticed you have missed several meetings and Activity 1. Is everything all right? Please see me during consultation hours.' });
    });
    await step('calendar, consultations and tasks', async () => {
      await admin.post('/calendar/events', { scope: 'INSTITUTION', type: 'HOLIDAY', title: 'Bonifacio Day (no classes)', startAt: '2026-11-29T16:00:00.000Z', endAt: '2026-11-30T15:59:00.000Z', allDay: true });
      await admin.post('/calendar/events', { scope: 'INSTITUTION', type: 'INSTITUTIONAL', title: 'Midterm examination week', startAt: '2026-11-22T16:00:00.000Z', endAt: '2026-11-27T15:59:00.000Z', allDay: true });
      await admin.post('/calendar/events', { scope: 'INSTITUTION', type: 'HOLIDAY', title: 'Christmas break begins', startAt: '2026-12-18T16:00:00.000Z', endAt: '2026-12-19T15:59:00.000Z', allDay: true });
      await teacher.post('/calendar/events', { scope: 'CLASS', classId: it101.id, type: 'CLASS_ACTIVITY', title: 'Computer laboratory orientation', location: 'Computer Lab 1', startAt: ahead(2, 1).toISOString(), endAt: ahead(2, 2).toISOString() });
      const slotStart = ahead(1);
      slotStart.setUTCHours(7, 0, 0, 0); // 3:00 PM in Manila
      const slot = await teacher.post('/consultations/slots', { startAt: slotStart.toISOString(), endAt: new Date(slotStart.getTime() + 1_800_000).toISOString(), location: 'CCS Faculty Room', capacity: 2, note: 'Bring your activity sheets.' });
      await teacher.post('/consultations/slots', { startAt: new Date(slotStart.getTime() + 2 * DAY).toISOString(), endAt: new Date(slotStart.getTime() + 2 * DAY + 1_800_000).toISOString(), location: 'CCS Faculty Room', capacity: 2 });
      await itStudents[0].post(`/consultations/slots/${slot.id}/book`, { topic: 'Questions about number system conversion' });
      await itStudents[0].post('/tasks', { title: 'Review Module 2 before Quiz 2', dueAt: ahead(2).toISOString() });
      await itStudents[0].post('/tasks', { title: 'Finish reflection essay draft', dueAt: ahead(3).toISOString() });
      const done = await itStudents[0].post('/tasks', { title: 'Buy a USB flash drive for laboratory work' });
      await itStudents[0].patch(`/tasks/${done.id}`, { completed: true });
      await teacher.post('/tasks', { title: 'Check Activity 2 submissions', dueAt: ahead(1).toISOString() });
    });
    await step('programming practice problem', async () => {
      await teacher.post('/programming/problems', {
        title: 'Sum of an array', classId: cs201.id, allowedLanguages: ['PYTHON', 'JAVA', 'CPP'],
        statementHtml: '<p>The first line contains an integer <code>n</code>. The second line contains <code>n</code> integers separated by spaces. Print their sum.</p><h4>Example</h4><pre><code>Input\n4\n3 1 4 1\n\nOutput\n9</code></pre>',
        starterCode: { PYTHON: 'n = int(input())\nnumbers = list(map(int, input().split()))\n# print the sum of the numbers\n' },
        testCases: [{ input: '4\n3 1 4 1\n', expectedOutput: '9' }, { input: '1\n42\n', expectedOutput: '42' }, { input: '5\n-1 -2 -3 -4 -5\n', expectedOutput: '-15', isHidden: true }, { input: '3\n1000000 2000000 3000000\n', expectedOutput: '6000000', isHidden: true }],
      });
    });
    // Publish the midterm grades so that students see their standing.
    await step('publish midterm grades of IT 101', async () => {
      const period = await prisma.gradingPeriod.findFirst({ where: { classId: it101.id }, orderBy: { position: 'asc' } });
      await teacher.post(`/classes/${it101.id}/gradebook/periods/${period.id}/publish`, { note: 'Partial midterm standing' });
    });
    // Leave a few notifications unread, the rest read, so the bell is believable.
    await prisma.notification.updateMany({ where: { createdAt: { lt: new Date(Date.now() - 2000) }, type: { notIn: ['assignment.returned', 'discussion.reply', 'consultation.booked', 'grades.published'] } }, data: { readAt: now } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return true;
}

console.log(`Seeding ${env.isProduction ? 'essentials (production)' : 'essentials and demo data'}…`);
let seededDemo = false;
try {
  await essentials();
  if (!env.isProduction) seededDemo = await demo();
  else log('NODE_ENV=production: demo accounts are not created');
} catch (err) {
  console.error('\nSeed failed:', err);
  process.exitCode = 1;
} finally {
  await disconnect();
}
if (seededDemo) {
  console.log(`\nDemo accounts (password for all: ${DEMO_PASSWORD})`);
  console.log(`  Administrator  admin@${DEMO_DOMAIN}`);
  console.log(`  Teacher        teacher@${DEMO_DOMAIN}   (also teacher2@${DEMO_DOMAIN})`);
  console.log(`  Student        student@${DEMO_DOMAIN}   (also student2 … student10@${DEMO_DOMAIN})`);
}
if (warnings.length > 0) {
  console.warn(`\nSeed finished with ${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(`  • ${w}`);
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log('\nSeed complete.');
}
// The realtime/mail modules may keep handles open; the work is done.
process.exit(process.exitCode ?? 0);
