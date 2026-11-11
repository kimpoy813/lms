// Runs before the app loads so that the page never flashes in the wrong colour scheme.
(function () {
  try {
    var saved = localStorage.getItem('edusphere.theme');
    var dark = saved === 'dark' || ((!saved || saved === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {
    /* storage unavailable: keep the light theme */
  }
})();
