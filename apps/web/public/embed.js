/*
 * Neato Agent Builder: floating "Talk to us" button.
 * Put this on any page:
 *   <script src="https://YOUR-APP/embed.js" data-agent="AGENT-ID" data-label="Talk to us" async></script>
 * Optional: data-position="left" to sit bottom-left instead of bottom-right.
 */
(function () {
  var script = document.currentScript;
  if (!script || document.getElementById("neato-agent-launcher")) return;
  var agent = script.getAttribute("data-agent");
  if (!agent || !/^[0-9a-f-]{36}$/i.test(agent)) return;
  var origin = new URL(script.src).origin;
  var label = script.getAttribute("data-label") || "Talk to us";
  var left = script.getAttribute("data-position") === "left";
  var side = left ? "left" : "right";

  var style = document.createElement("style");
  style.textContent =
    "#neato-agent-launcher{position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;font:600 15px/1 system-ui,-apple-system,Segoe UI,sans-serif}" +
    "#neato-agent-launcher button{display:flex;align-items:center;gap:8px;min-height:48px;padding:0 20px;border:0;border-radius:999px;background:#0f766e;color:#fff;font:inherit;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.28)}" +
    "#neato-agent-launcher button:hover{background:#115e59}" +
    "#neato-agent-launcher button:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px #0f766e}" +
    "#neato-agent-panel{position:fixed;bottom:84px;" + side + ":20px;z-index:2147483000;width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 110px);border:1px solid rgba(255,255,255,.14);border-radius:16px;overflow:hidden;background:#0b0d14;box-shadow:0 12px 40px rgba(0,0,0,.4)}" +
    "#neato-agent-panel[hidden]{display:none}" +
    "#neato-agent-panel iframe{width:100%;height:100%;border:0}";
  document.head.appendChild(style);

  var wrap = document.createElement("div");
  wrap.id = "neato-agent-launcher";
  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "neato-agent-panel");
  btn.textContent = label;
  wrap.appendChild(btn);

  var panel = document.createElement("div");
  panel.id = "neato-agent-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", label);
  panel.hidden = true;

  function open() {
    if (!panel.firstChild) {
      var frame = document.createElement("iframe");
      frame.src = origin + "/embed/" + agent;
      frame.title = label;
      frame.allow = "microphone; autoplay";
      frame.referrerPolicy = "origin";
      panel.appendChild(frame);
    }
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  }
  function close() {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.focus();
  }
  btn.addEventListener("click", function () { panel.hidden ? open() : close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) close(); });

  document.body.appendChild(panel);
  document.body.appendChild(wrap);
})();
