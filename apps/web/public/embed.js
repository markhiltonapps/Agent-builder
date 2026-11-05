/*
 * Neato Agent Builder: floating "Talk to us" button.
 *
 *   <script src="https://YOUR-APP/embed.js" data-agent="AGENT-ID" async></script>
 *
 * Optional look, all as data- attributes (the Put on website page writes these for you):
 *   data-label     the words on the button
 *   data-position  bottom-right | bottom-left | bottom-center | top-right | top-left | top-center
 *   data-shape     pill | rounded | square | circle
 *   data-size      small | medium | large
 *   data-style     solid | glass | outline
 *   data-icon      none | mic | phone | chat
 *   data-edge      tight | normal | roomy      (distance from the screen edge)
 *   data-color     #rrggbb                      (button colour; the text colour is chosen to be readable)
 */
(function () {
  var script = document.currentScript;
  if (!script || document.getElementById("neato-agent-launcher")) return;
  var agent = script.getAttribute("data-agent");
  if (!agent || !/^[0-9a-f-]{36}$/i.test(agent)) return;
  var origin = new URL(script.src).origin;

  function pick(name, allowed, fallback) {
    var v = (script.getAttribute("data-" + name) || "").toLowerCase();
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }
  var label = (script.getAttribute("data-label") || "Talk to us").slice(0, 40);
  var position = (script.getAttribute("data-position") || "").toLowerCase();
  if (position === "left") position = "bottom-left";
  if (position === "right") position = "bottom-right";
  if (["bottom-right", "bottom-left", "bottom-center", "top-right", "top-left", "top-center"].indexOf(position) < 0) position = "bottom-right";
  var shape = pick("shape", ["pill", "rounded", "square", "circle"], "pill");
  var size = pick("size", ["small", "medium", "large"], "medium");
  var look = pick("style", ["solid", "glass", "outline"], "solid");
  var icon = pick("icon", ["none", "mic", "phone", "chat"], "none");
  var edgeName = pick("edge", ["tight", "normal", "roomy"], "normal");
  var color = script.getAttribute("data-color") || "";
  if (!/^#[0-9a-f]{6}$/i.test(color)) color = "#0f766e";
  var preview = script.getAttribute("data-preview") === "true";

  var dims = { small: { h: 40, font: 13, icon: 16 }, medium: { h: 48, font: 15, icon: 18 }, large: { h: 60, font: 18, icon: 22 } }[size];
  var edge = { tight: 12, normal: 20, roomy: 32 }[edgeName];
  var radius = { pill: "999px", circle: "999px", rounded: "14px", square: "4px" }[shape];
  if (shape === "circle" && icon === "none") icon = "mic"; // a round button needs a picture

  function rgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }
  function luminance(hex) {
    var c = rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  var light = luminance(color) > 0.4;
  var ink = light ? "#0b0d14" : "#ffffff";
  var c3 = rgb(color).join(",");
  var surface, text, border;
  if (look === "glass") { surface = "rgba(" + c3 + ",.55)"; text = light ? "#0b0d14" : "#ffffff"; border = "1px solid rgba(255,255,255,.55)"; }
  else if (look === "outline") { surface = "#ffffff"; text = luminance(color) > 0.55 ? "#0b0d14" : color; border = "2px solid " + color; }
  else { surface = color; text = ink; border = "1px solid rgba(255,255,255,.18)"; }

  var parts = position.split("-"), vert = parts[0], horiz = parts[1];
  var horizCss = horiz === "center" ? "left:50%;transform:translateX(-50%);" : horiz + ":" + edge + "px;";
  var panelOffset = edge + dims.h + 12;

  var icons = {
    mic: '<svg width="' + dims.icon + '" height="' + dims.icon + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>',
    phone: '<svg width="' + dims.icon + '" height="' + dims.icon + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
    chat: '<svg width="' + dims.icon + '" height="' + dims.icon + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12z"/></svg>'
  };

  var style = document.createElement("style");
  style.textContent =
    "#neato-agent-launcher{position:fixed;" + vert + ":" + edge + "px;" + horizCss + "z-index:2147483000;font:600 " + dims.font + "px/1 system-ui,-apple-system,Segoe UI,sans-serif}" +
    "#neato-agent-launcher button{display:flex;align-items:center;justify-content:center;gap:8px;height:" + dims.h + "px;" + (shape === "circle" ? "width:" + dims.h + "px;padding:0;" : "padding:0 " + Math.round(dims.h * 0.42) + "px;") +
      "border:" + border + ";border-radius:" + radius + ";background:" + surface + ";color:" + text + ";font:inherit;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.28);" + (look === "glass" ? "-webkit-backdrop-filter:blur(14px) saturate(1.5);backdrop-filter:blur(14px) saturate(1.5);" : "") + "transition:transform .15s}" +
    "#neato-agent-launcher button:hover{transform:translateY(-1px)}" +
    "#neato-agent-launcher button:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 6px #111}" +
    "#neato-agent-panel{position:fixed;" + vert + ":" + panelOffset + "px;" + horizCss + "z-index:2147483000;width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - " + (panelOffset + 16) + "px);border:1px solid rgba(255,255,255,.14);border-radius:16px;overflow:hidden;background:#0b0d14;box-shadow:0 12px 40px rgba(0,0,0,.4)}" +
    "#neato-agent-panel[hidden]{display:none}" +
    "#neato-agent-panel iframe{width:100%;height:100%;border:0}" +
    "@media (max-width:480px){#neato-agent-panel{left:12px!important;right:12px!important;width:auto;transform:none!important}}" +
    "@media (prefers-reduced-motion:reduce){#neato-agent-launcher button{transition:none}}";
  document.head.appendChild(style);

  var wrap = document.createElement("div");
  wrap.id = "neato-agent-launcher";
  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "neato-agent-panel");
  if (shape === "circle") btn.setAttribute("aria-label", label);
  btn.innerHTML = (icons[icon] || "") + (shape === "circle" ? "" : "<span></span>");
  var span = btn.querySelector("span");
  if (span) span.textContent = label;
  wrap.appendChild(btn);

  var panel = document.createElement("div");
  panel.id = "neato-agent-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", label);
  panel.hidden = true;

  function open() {
    if (!panel.firstChild) {
      if (preview) {
        var note = document.createElement("div");
        note.style.cssText = "display:grid;place-items:center;height:100%;padding:24px;text-align:center;color:#c4cadc;font:500 14px/1.5 system-ui,sans-serif";
        note.textContent = "Your call box opens here. In this preview, calls are switched off.";
        panel.appendChild(note);
      } else {
        var frame = document.createElement("iframe");
        frame.src = origin + "/embed/" + agent;
        frame.title = label;
        frame.allow = "microphone; autoplay";
        frame.referrerPolicy = "origin";
        panel.appendChild(frame);
      }
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
