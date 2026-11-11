#!/usr/bin/env node
// Generates docs/API.md from the routers themselves, so the reference cannot drift from the code:
//   • mount points are read from src/routes.js
//   • methods, paths, role guards and the zod schemas of every route are read from the live
//     router objects (validate() and requireRole() keep their arguments for this purpose).
//
//   npm run docs:api
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

process.env.NODE_ENV ??= 'development';
process.env.SCHEDULER_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ??= 'postgresql://docs:docs@127.0.0.1:1/docs'; // never connected to

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', 'src');
const out = path.resolve(here, '..', '..', 'docs', 'API.md');
const routesSource = fs.readFileSync(path.join(src, 'routes.js'), 'utf8');

// import { a, b } from './modules/x/y.js'  →  identifier → file
const fileOf = new Map();
for (const m of routesSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/modules\/[^']+)'/g)) {
  for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) fileOf.set(name, m[2]);
}
// apiRouter.use('/path', [guards…,] someRouter)   → a mounted router
// apiRouter.use(PREFIXES, requireAuth)            → a guard in front of every path under those prefixes
const mounts = [];
const prefixGuards = [];
for (const m of routesSource.matchAll(/apiRouter\.use\(\s*('([^']*)'|([A-Z_]+))\s*,\s*([^)]*)\)/g)) {
  const args = m[4].split(',').map((s) => s.trim());
  const ident = args.at(-1);
  if (fileOf.has(ident)) {
    // A router mounted at the API root has the mount path '/'.
    mounts.push({ mount: (m[2] ?? '').replace(/\/+$/, ''), ident, guards: args.slice(0, -1) });
  } else if (args.includes('requireAuth')) {
    let prefixes = m[2] !== undefined ? [m[2]] : [];
    if (m[3] && fileOf.has(m[3])) prefixes = (await import(pathToFileURL(path.join(src, fileOf.get(m[3]))).href))[m[3]] ?? [];
    for (const prefix of prefixes) prefixGuards.push(prefix.replace(/\/+$/, ''));
  }
}
/** True when routes.js puts requireAuth in front of this path (given without the /api prefix). */
const guardedByPrefix = (route) => prefixGuards.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));

const TITLES = {
  auth: 'Authentication and account', files: 'Files', catalog: 'Academic catalogue', enrollments: 'Enrolment', classes: 'Classes', admin: 'Administration',
  attendance: 'Attendance', announcements: 'Announcements', notifications: 'Notifications', grades: 'Grades', assignments: 'Assignments', rubrics: 'Rubrics',
  'question-banks': 'Question banks', quizzes: 'Quizzes and examinations', attempts: 'Quiz attempts', dashboard: 'Dashboards', messages: 'Direct messages',
  discussions: 'Discussions', calendar: 'Calendar', consultations: 'Consultations', tasks: 'Personal tasks', search: 'Search', programming: 'Programming problems',
  ai: 'AI-assisted authoring', content: 'Learning content (modules, lessons, resources)',
};

function typeOf(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' \\| ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.anyOf) return [...new Set(schema.anyOf.map(typeOf))].join(' \\| ');
  if (schema.type === 'array') return `${typeOf(schema.items)}[]`;
  if (schema.type === 'object') return schema.properties ? `{ ${Object.keys(schema.properties).join(', ')} }` : 'object';
  if (Array.isArray(schema.type)) return schema.type.join(' \\| ');
  return schema.type ?? 'any';
}

function fields(zodSchema) {
  if (!zodSchema) return '';
  let json;
  try {
    json = z.toJSONSchema(zodSchema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return '_see source_';
  }
  if (!json.properties) return typeOf(json);
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties)
    .map(([name, s]) => `\`${name}${required.has(name) ? '' : '?'}\`: ${typeOf(s)}${s.default !== undefined && typeof s.default !== 'object' ? ` = ${JSON.stringify(s.default)}` : ''}`)
    .join('<br>');
}

const guardInfo = (handles) => {
  const info = { auth: false, roles: null, permission: null, limiter: false };
  for (const h of handles) {
    if (h.name === 'requireAuth') info.auth = true;
    if (h.roles) info.roles = h.roles;
    if (h.permission) info.permission = h.permission;
    if (/limit/i.test(h.name ?? '') || h.name === 'rateLimitMiddleware' || typeof h.resetKey === 'function') info.limiter = true;
  }
  return info;
};

const sections = new Map();
let total = 0;

function sectionOf(mount) {
  const key = mount.startsWith('/classes/:classId/') ? mount.split('/')[3] : mount.split('/')[1] || 'content';
  if (key === 'people') return 'enrollments';
  if (key === 'gradebook') return 'grades';
  if (key === 'analytics') return 'dashboard';
  if (['modules', 'lessons', 'resources', 'bookmarks', 'modules-progress'].includes(key) || mount === '' || mount === '/classes/:classId') return 'content';
  return key;
}

/** Document a router and (recursively) the routers mounted inside it with lib/http.js mount(). */
function describe(router, mount, section, inherited) {
  const base = guardInfo(router.stack.filter((l) => !l.route).map((l) => l.handle));
  base.auth ||= inherited.auth;
  base.roles ??= inherited.roles;
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const handles = layer.route.stack.map((l) => l.handle);
    const own = guardInfo(handles);
    const schemas = handles.find((h) => h.schemas)?.schemas ?? {};
    const route = `${mount}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/\/{2,}/g, '/');
    const fullPath = `/api${route}`;
    const roles = own.roles ?? base.roles;
    const access = !(base.auth || own.auth || roles || guardedByPrefix(route)) ? 'public' : roles ? roles.map((r) => r.toLowerCase()).join(', ') : 'signed in';
    for (const method of Object.keys(layer.route.methods)) {
      if (!sections.has(section)) sections.set(section, []);
      sections.get(section).push({ method: method.toUpperCase(), path: fullPath, access: `${access}${own.permission ? `<br>permission \`${own.permission}\`` : ''}${own.limiter ? '<br>rate limited' : ''}`, query: fields(schemas.query), body: fields(schemas.body) });
      total += 1;
    }
  }
  for (const child of router.mounted ?? []) describe(child.router, `${mount}${child.path}`, section, base);
}

for (const { mount, ident, guards } of mounts) {
  const mod = await import(pathToFileURL(path.join(src, fileOf.get(ident))).href);
  const router = mod[ident];
  if (!router?.stack) continue;
  describe(router, mount, sectionOf(mount), { auth: guards.includes('requireAuth'), roles: null });
}

const lines = [
  '# EduSphere API reference',
  '',
  '> Generated by `npm run docs:api` from the route definitions — do not edit by hand.',
  '',
  `${total} endpoints under \`/api\`. Health checks live outside it: \`GET /healthz\` (process is up) and \`GET /readyz\` (database reachable).`,
  '',
  '## Conventions',
  '',
  '- **Format** — JSON. Success: `{ "data": …, "meta"?: … }`. Failure: `{ "error": { "code", "message", "details"? } }`.',
  '- **Authentication** — an HTTP-only session cookie set by `POST /api/auth/login`. There are no bearer tokens to store in the browser.',
  '- **CSRF** — every request other than `GET`/`HEAD` must send the header `X-CSRF-Token` with the token returned by `POST /api/auth/login` or `GET /api/auth/session`, and must come from a trusted origin.',
  '- **Validation** — `422 VALIDATION_ERROR` with `details.fields` (`{ field: message }`).',
  '- **Access** — "signed in" endpoints still check membership: a class you do not belong to answers `404`, an action your role may not perform answers `403`. Role names in the tables are the roles allowed to call the endpoint at all.',
  '- **Pagination** — `?page=1&pageSize=20`; the response carries `meta: { page, pageSize, total, totalPages }`.',
  '- **Exports** — `?format=csv|xlsx|pdf` where an export endpoint exists.',
  '- **Dates** — ISO 8601 in UTC. Calendar days and class times follow the institution time zone (setting `institution.timezone`, default `Asia/Manila`).',
  '- **Real time** — Socket.IO at `/socket.io`, authenticated by the same cookie. Events: `notification:new`, `message:new`, `message:read`, `message:deleted`, `attendance:update` (room `attendance:<sessionId>`, teachers only).',
  '',
  'In the tables, `name?` marks an optional field and `= value` a default.',
  '',
];
const order = Object.keys(TITLES);
for (const key of [...sections.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))) {
  lines.push(`## ${TITLES[key] ?? key}`, '', '| Method | Path | Access | Query | Body |', '|---|---|---|---|---|');
  for (const r of sections.get(key)) lines.push(`| ${r.method} | \`${r.path}\` | ${r.access} | ${r.query} | ${r.body} |`);
  lines.push('');
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}`);
console.log(`Wrote ${path.relative(process.cwd(), out)} — ${total} endpoints in ${sections.size} sections.`);
process.exit(0);
