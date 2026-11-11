import secrets
from django.conf import settings
from django.core.validators import FileExtensionValidator, MinValueValidator
from django.db import models

User = settings.AUTH_USER_MODEL

ALLOWED_FILES = ["pdf", "doc", "docx", "ppt", "pptx", "txt", "png", "jpg", "jpeg", "zip", "py", "java", "js", "c", "cpp", "html", "css"]
file_validator = FileExtensionValidator(ALLOWED_FILES)


def new_join_code():
    return secrets.token_hex(4).upper()


class Profile(models.Model):
    TEACHER = "TEACHER"
    STUDENT = "STUDENT"
    ROLE_CHOICES = [(TEACHER, "Teacher"), (STUDENT, "Student")]
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="profile")
    role = models.CharField(max_length=10, choices=ROLE_CHOICES, default=STUDENT)

    def __str__(self):
        return f"{self.user.username} ({self.get_role_display()})"


class Course(models.Model):
    teacher = models.ForeignKey(User, on_delete=models.CASCADE, related_name="teaching_courses")
    title = models.CharField(max_length=160)
    subject_code = models.CharField(max_length=32)
    section = models.CharField(max_length=80, blank=True)
    description = models.TextField(blank=True)
    join_code = models.CharField(max_length=10, unique=True, default=new_join_code, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.subject_code} - {self.title}"


class Enrollment(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="enrollments")
    student = models.ForeignKey(User, on_delete=models.CASCADE, related_name="enrollments")
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["course", "student"], name="unique_course_student")]

    def __str__(self):
        return f"{self.student.username} in {self.course.subject_code}"


class LearningModule(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="modules")
    title = models.CharField(max_length=180)
    content = models.TextField(blank=True)
    attachment = models.FileField(upload_to="modules/", blank=True, validators=[file_validator])
    position = models.PositiveIntegerField(default=1)
    published = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self):
        return self.title


class Assignment(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="assignments")
    title = models.CharField(max_length=180)
    instructions = models.TextField()
    attachment = models.FileField(upload_to="assignments/", blank=True, validators=[file_validator])
    due_at = models.DateTimeField()
    max_score = models.PositiveIntegerField(default=100, validators=[MinValueValidator(1)])
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["due_at"]

    def __str__(self):
        return self.title


class Submission(models.Model):
    assignment = models.ForeignKey(Assignment, on_delete=models.CASCADE, related_name="submissions")
    student = models.ForeignKey(User, on_delete=models.CASCADE, related_name="submissions")
    text = models.TextField(blank=True)
    attachment = models.FileField(upload_to="submissions/", blank=True, validators=[file_validator])
    submitted_at = models.DateTimeField(auto_now=True)
    score = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)
    feedback = models.TextField(blank=True)
    graded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["assignment", "student"], name="unique_assignment_submission")]

    @property
    def is_late(self):
        return self.submitted_at > self.assignment.due_at


class AttendanceSession(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="attendance_sessions")
    title = models.CharField(max_length=120, default="Class meeting")
    date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-date", "-id"]


class AttendanceRecord(models.Model):
    PRESENT = "P"
    ABSENT = "A"
    LATE = "L"
    EXCUSED = "E"
    STATUS_CHOICES = [(PRESENT, "Present"), (ABSENT, "Absent"), (LATE, "Late"), (EXCUSED, "Excused")]
    session = models.ForeignKey(AttendanceSession, on_delete=models.CASCADE, related_name="records")
    student = models.ForeignKey(User, on_delete=models.CASCADE, related_name="attendance_records")
    status = models.CharField(max_length=1, choices=STATUS_CHOICES)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["session", "student"], name="unique_session_student")]


class Announcement(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="announcements")
    title = models.CharField(max_length=180)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class Quiz(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="quizzes")
    title = models.CharField(max_length=180)
    description = models.TextField(blank=True)
    published = models.BooleanField(default=False)
    due_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    @property
    def total_points(self):
        return sum(q.points for q in self.questions.all())


class QuizQuestion(models.Model):
    quiz = models.ForeignKey(Quiz, on_delete=models.CASCADE, related_name="questions")
    prompt = models.TextField()
    choice_a = models.CharField(max_length=300)
    choice_b = models.CharField(max_length=300)
    choice_c = models.CharField(max_length=300)
    choice_d = models.CharField(max_length=300)
    correct = models.CharField(max_length=1, choices=[(x, x) for x in "ABCD"])
    points = models.PositiveIntegerField(default=1, validators=[MinValueValidator(1)])

    class Meta:
        ordering = ["id"]


class QuizAttempt(models.Model):
    quiz = models.ForeignKey(Quiz, on_delete=models.CASCADE, related_name="attempts")
    student = models.ForeignKey(User, on_delete=models.CASCADE, related_name="quiz_attempts")
    answers = models.JSONField(default=dict)
    score = models.PositiveIntegerField(default=0)
    submitted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["quiz", "student"], name="unique_quiz_attempt")]


class DiscussionTopic(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="topics")
    author = models.ForeignKey(User, on_delete=models.CASCADE)
    title = models.CharField(max_length=180)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class DiscussionReply(models.Model):
    topic = models.ForeignKey(DiscussionTopic, on_delete=models.CASCADE, related_name="replies")
    author = models.ForeignKey(User, on_delete=models.CASCADE)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

