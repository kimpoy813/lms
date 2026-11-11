from pathlib import Path
from django import forms
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.utils import timezone
from .models import (
    Profile, Course, LearningModule, Assignment, Submission,
    AttendanceSession, Announcement, Quiz, QuizQuestion,
    DiscussionTopic, DiscussionReply,
)

MAX_UPLOAD_SIZE = 10 * 1024 * 1024


class SizedUploadForm(forms.ModelForm):
    def clean(self):
        cleaned = super().clean()
        attachment = cleaned.get("attachment")
        if attachment and attachment.size > MAX_UPLOAD_SIZE:
            self.add_error("attachment", "Please upload a file smaller than 10 MB.")
        return cleaned


class RegisterForm(UserCreationForm):
    first_name = forms.CharField(max_length=150)
    last_name = forms.CharField(max_length=150)
    email = forms.EmailField(required=True)
    role = forms.ChoiceField(choices=Profile.ROLE_CHOICES)

    class Meta:
        model = User
        fields = ["first_name", "last_name", "username", "email", "role", "password1", "password2"]

    def clean_email(self):
        email = self.cleaned_data["email"].strip().lower()
        if User.objects.filter(email__iexact=email).exists():
            raise ValidationError("An account already uses that email.")
        return email


class CourseForm(forms.ModelForm):
    class Meta:
        model = Course
        fields = ["title", "subject_code", "section", "description"]
        widgets = {"description": forms.Textarea(attrs={"rows": 4})}


class ModuleForm(SizedUploadForm):
    class Meta:
        model = LearningModule
        fields = ["title", "content", "attachment", "position", "published"]
        widgets = {"content": forms.Textarea(attrs={"rows": 7})}


class AssignmentForm(SizedUploadForm):
    due_at = forms.SplitDateTimeField(
        widget=forms.SplitDateTimeWidget(date_attrs={"type": "date"}, time_attrs={"type": "time"}),
        initial=timezone.now,
    )

    class Meta:
        model = Assignment
        fields = ["title", "instructions", "attachment", "due_at", "max_score"]
        widgets = {"instructions": forms.Textarea(attrs={"rows": 6})}


class SubmissionForm(SizedUploadForm):
    class Meta:
        model = Submission
        fields = ["text", "attachment"]
        widgets = {"text": forms.Textarea(attrs={"rows": 7, "placeholder": "Write your answer, attach a file, or both..."})}

    def clean(self):
        cleaned = super().clean()
        if not cleaned.get("text") and not cleaned.get("attachment") and not self.instance.attachment:
            raise ValidationError("Enter an answer or attach a file.")
        return cleaned


class AttendanceSessionForm(forms.ModelForm):
    class Meta:
        model = AttendanceSession
        fields = ["title", "date"]
        widgets = {"date": forms.DateInput(attrs={"type": "date"})}


class AnnouncementForm(forms.ModelForm):
    class Meta:
        model = Announcement
        fields = ["title", "body"]
        widgets = {"body": forms.Textarea(attrs={"rows": 5})}


class QuizForm(forms.ModelForm):
    class Meta:
        model = Quiz
        fields = ["title", "description", "published", "due_at"]
        widgets = {
            "description": forms.Textarea(attrs={"rows": 3}),
            "due_at": forms.DateTimeInput(attrs={"type": "datetime-local"}, format="%Y-%m-%dT%H:%M"),
        }


class QuizQuestionForm(forms.ModelForm):
    class Meta:
        model = QuizQuestion
        fields = ["prompt", "choice_a", "choice_b", "choice_c", "choice_d", "correct", "points"]
        widgets = {"prompt": forms.Textarea(attrs={"rows": 3})}


class TopicForm(forms.ModelForm):
    class Meta:
        model = DiscussionTopic
        fields = ["title", "body"]
        widgets = {"body": forms.Textarea(attrs={"rows": 5})}


class ReplyForm(forms.ModelForm):
    class Meta:
        model = DiscussionReply
        fields = ["body"]
        widgets = {"body": forms.Textarea(attrs={"rows": 3, "placeholder": "Write your reply..."})}


class GradeForm(forms.Form):
    score = forms.DecimalField(min_value=0, max_digits=7, decimal_places=2)
    feedback = forms.CharField(widget=forms.Textarea(attrs={"rows": 4}), required=False)

    def __init__(self, *args, max_score=100, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["score"].max_value = max_score

    def clean_score(self):
        value = self.cleaned_data["score"]
        if value > self.fields["score"].max_value:
            raise ValidationError("Score cannot exceed the maximum points.")
        return value

