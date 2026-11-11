from django.contrib import admin
from .models import (
    Profile, Course, Enrollment, LearningModule, Assignment, Submission,
    AttendanceSession, AttendanceRecord, Announcement, Quiz, QuizQuestion,
    QuizAttempt, DiscussionTopic, DiscussionReply,
)
for model in (
    Profile, Course, Enrollment, LearningModule, Assignment, Submission,
    AttendanceSession, AttendanceRecord, Announcement, Quiz, QuizQuestion,
    QuizAttempt, DiscussionTopic, DiscussionReply,
):
    admin.site.register(model)

