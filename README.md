# Academe LMS

Responsive, browser-local teacher-and-student LMS prototype. Open `index.html` directly in a browser, or host it on GitHub Pages, Netlify, or another static host.

## Features

Teacher: courses, join codes, modules with links, assignments, submission grading and feedback, manual attendance, quiz creation and automatic scoring, announcements, and a dashboard.

Student: enrollment by join code, learning modules, assignment text/link submissions, grades and feedback, attendance history, quiz attempts, announcements, and a dashboard.

## Demo accounts

Use the account button to switch between two sample teachers and three students. The initial data includes courses, lessons, assignments, attendance, submissions and one quiz. Browser localStorage retains changes; reset demo data from the account switcher.

## Important limitations

This is a demo, NOT a production school system. No account authentication or backend is configured. Data is saved per browser only, not shared across users or devices. Switching accounts is a local demo feature, not secure role enforcement. Attachments are supported as shareable links/text rather than uploaded files. Quizzes created through the interface currently offer a one-question multiple-choice format. Do not store real student or sensitive information.

## Next production steps

Add a secure authentication service, a shared database, server-side role and enrollment checks, private attachment storage, audit logs, data backups, advanced assessments, and school privacy policies before real use.
