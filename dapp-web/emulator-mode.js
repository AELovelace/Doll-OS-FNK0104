const mode = new URLSearchParams(window.location.search).get("terminal");
const isFramed = window.self !== window.top;
if (isFramed) document.documentElement.classList.add("iframe-embed");
if (isFramed || mode === "1" || mode === "true") document.documentElement.classList.add("terminal-embed");
