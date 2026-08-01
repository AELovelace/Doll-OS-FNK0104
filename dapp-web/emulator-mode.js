const mode = new URLSearchParams(window.location.search).get("terminal");
if (mode === "1" || mode === "true") document.documentElement.classList.add("terminal-embed");
