def user_role(request):
    if request.user.is_authenticated:
        profile = getattr(request.user, "profile", None)
        return {"app_role": profile.role if profile else "STUDENT"}
    return {"app_role": None}

