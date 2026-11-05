/*
 * Neato Agent Builder: floating "Talk to us" button.
 *
 *   <script src="https://YOUR-APP/embed.js" data-agent="AGENT-ID" async></script>
 *
 * Optional look, all as data- attributes (the Put on website page writes these for you):
 *   data-label     the words on the button
 *   data-position  bottom-right | bottom-left | bottom-center | top-right | top-left | top-center
 *   data-shape     pill | rounded | square | circle | orb   (orb: a small glowing, pulsing sphere)
 *   data-size      small | medium | large
 *   data-style     solid | glass | outline
 *   data-icon      none | mic | phone | chat
 *   data-edge      tight | normal | roomy      (distance from the screen edge)
 *   data-color     #rrggbb                      (button colour; the text colour is chosen to be readable)
 *   data-logo      https://...                  (a small picture shown on the button, or inside the orb)
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
  var shape = pick("shape", ["pill", "rounded", "square", "circle", "orb"], "pill");
  var size = pick("size", ["small", "medium", "large"], "medium");
  var look = pick("style", ["solid", "glass", "outline"], "solid");
  var icon = pick("icon", ["none", "mic", "phone", "chat"], "none");
  var edgeName = pick("edge", ["tight", "normal", "roomy"], "normal");
  var color = script.getAttribute("data-color") || "";
  if (!/^#[0-9a-f]{6}$/i.test(color)) color = "#0f766e";
  var logo = script.getAttribute("data-logo") || "";
  if (!/^https:\/\/[^\s"'<>\\]{1,400}$/.test(logo)) logo = "";
  var preview = script.getAttribute("data-preview") === "true";
  var orb = shape === "orb";

  var dims = (orb
    ? { small: { h: 44, font: 13, icon: 16 }, medium: { h: 56, font: 14, icon: 20 }, large: { h: 72, font: 15, icon: 26 } }
    : { small: { h: 40, font: 13, icon: 16 }, medium: { h: 48, font: 15, icon: 18 }, large: { h: 60, font: 18, icon: 22 } })[size];
  var edge = { tight: 12, normal: 20, roomy: 32 }[edgeName];
  var radius = { pill: "999px", circle: "999px", rounded: "14px", square: "4px", orb: "50%" }[shape];
  if (shape === "circle" && icon === "none" && !logo) icon = "mic"; // a round button needs a picture

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

  // The orb: a glowing sphere with a slowly swirling inside and soft rings that pulse outward.
  function mix(hex, to, t) { return rgb(hex).map(function (v, i) { return Math.round(v + (to[i] - v) * t); }).join(","); }
  var orbLight = mix(color, [255, 255, 255], 0.6), orbDark = mix(color, [0, 0, 0], 0.5);
  var glow = light ? mix(color, [0, 0, 0], 0.35) : c3; // rings and glow must show on a white page
  var tipPlace = horiz === "center"
    ? (vert === "top" ? "top:calc(100% + 14px);" : "bottom:calc(100% + 14px);") + "left:50%;transform:translateX(-50%);"
    : (horiz === "left" ? "left:calc(100% + 14px);" : "right:calc(100% + 14px);") + "top:50%;transform:translateY(-50%);";
  var orbCss =
    "#neato-agent-launcher button.orb{position:relative;width:" + dims.h + "px;height:" + dims.h + "px;padding:0;border:0;border-radius:50%;background:transparent;box-shadow:none;overflow:visible}" +
    "#neato-agent-launcher button.orb:hover{transform:scale(1.06)}" +
    ".neato-core{position:absolute;inset:0;border-radius:50%;overflow:hidden;display:grid;place-items:center;color:" + ink + ";background:radial-gradient(circle at 32% 26%,rgb(" + orbLight + ") 0%,rgb(" + c3 + ") 48%,rgb(" + orbDark + ") 100%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.28),0 0 22px rgba(" + glow + ",.65),0 8px 22px rgba(0,0,0,.28);animation:neato-breath 3.2s ease-in-out infinite}" +
    ".neato-swirl{position:absolute;inset:-30%;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 20%,rgba(255,255,255,.6) 32%,transparent 46%,rgba(" + orbLight + ",.7) 66%,transparent 82%);filter:blur(7px);mix-blend-mode:screen;animation:neato-spin 7s linear infinite}" +
    ".neato-swirl.b{background:conic-gradient(from 180deg,transparent 0 24%,rgba(" + orbDark + ",.55) 40%,transparent 56%,rgba(255,255,255,.4) 78%,transparent 92%);mix-blend-mode:normal;animation-duration:11s;animation-direction:reverse}" +
    ".neato-gloss{position:absolute;left:17%;top:9%;width:48%;height:30%;border-radius:50%;background:radial-gradient(ellipse at 50% 40%,rgba(255,255,255,.7),transparent 72%)}" +
    ".neato-ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(" + glow + ",.6);pointer-events:none;animation:neato-ring 2.8s ease-out infinite}" +
    ".neato-ring.r2{animation-delay:1.4s}" +
    "#neato-agent-launcher button[aria-expanded=true] .neato-ring{display:none}" +
    ".neato-core>svg,.neato-core>img{position:relative;z-index:2}" +
    ".neato-tip{position:absolute;" + tipPlace + "width:max-content;max-width:min(240px,calc(100vw - " + (dims.h + edge * 2 + 30) + "px));padding:9px 13px;border-radius:14px;background:rgba(15,18,28,.9);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;font:600 " + dims.font + "px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;text-align:left;box-shadow:0 8px 24px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .25s}" +
    "#neato-agent-launcher button:hover .neato-tip,#neato-agent-launcher button:focus-visible .neato-tip,#neato-agent-launcher button.peek .neato-tip{opacity:1}" +
    "#neato-agent-launcher button[aria-expanded=true] .neato-tip{opacity:0!important}" +
    "@keyframes neato-ring{0%{transform:scale(1);opacity:.7}100%{transform:scale(2.1);opacity:0}}" +
    "@keyframes neato-breath{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}" +
    "@keyframes neato-spin{to{transform:rotate(360deg)}}" +
    "@media (prefers-reduced-motion:reduce){.neato-ring{display:none}.neato-core,.neato-swirl{animation:none}.neato-tip{transition:none}}";

  var logoSize = dims.h - 12;
  var plainCss =
    "#neato-agent-launcher button{display:flex;align-items:center;justify-content:center;gap:8px;height:" + dims.h + "px;" + (shape === "circle" ? "width:" + dims.h + "px;padding:0;" : "padding:0 " + Math.round(dims.h * 0.42) + "px 0 " + (logo ? 6 : Math.round(dims.h * 0.42)) + "px;") +
      "border:" + border + ";border-radius:" + radius + ";background:" + surface + ";color:" + text + ";font:inherit;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.28);" + (look === "glass" ? "-webkit-backdrop-filter:blur(14px) saturate(1.5);backdrop-filter:blur(14px) saturate(1.5);" : "") + "transition:transform .15s}" +
    "#neato-agent-launcher button:hover{transform:translateY(-1px)}" +
    ".neato-logo{width:" + logoSize + "px;height:" + logoSize + "px;flex:none;object-fit:cover;border-radius:" + (shape === "square" ? "3px" : "50%") + ";background:#fff}";

  var style = document.createElement("style");
  style.textContent =
    "#neato-agent-launcher{position:fixed;" + vert + ":" + edge + "px;" + horizCss + "z-index:2147483000;font:600 " + dims.font + "px/1 system-ui,-apple-system,Segoe UI,sans-serif}" +
    (orb ? "" : plainCss) +
    "#neato-agent-launcher button{cursor:pointer;font:inherit}" +
    (orb ? orbCss : "") +
    "#neato-agent-launcher button:focus-visible{outline:3px solid #fff;outline-offset:" + (orb ? 5 : 2) + "px;box-shadow:0 0 0 " + (orb ? 8 : 6) + "px #111}" +
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

  // The picture on the button: your logo if you gave one (and it loads), otherwise the chosen icon.
  function makeLogo() {
    var img = document.createElement("img");
    img.className = "neato-logo";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.src = logo;
    if (orb) img.style.cssText = "width:56%;height:56%;border-radius:50%;object-fit:cover;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.3)";
    return img;
  }
  function iconNode() {
    var holder = document.createElement("span");
    holder.innerHTML = icons[icon] || "";
    return holder.firstChild;
  }
  var picture = null;
  function fillPicture(host) {
    var node = null;
    if (logo) {
      node = makeLogo();
      node.addEventListener("error", function () {
        var fallback = iconNode() || (shape === "circle" ? iconNodeFor("mic") : null);
        if (fallback) node.replaceWith(fallback); else node.remove();
      });
    } else {
      node = iconNode();
    }
    if (node) host.insertBefore(node, host.firstChild);
    picture = node;
  }
  function iconNodeFor(name) { var h = document.createElement("span"); h.innerHTML = icons[name]; return h.firstChild; }

  if (orb) {
    btn.className = "orb";
    btn.setAttribute("aria-label", label);
    btn.innerHTML = '<span class="neato-ring"></span><span class="neato-ring r2"></span><span class="neato-core"><span class="neato-swirl"></span><span class="neato-swirl b"></span><span class="neato-gloss"></span></span><span class="neato-tip" aria-hidden="true"></span>';
    btn.querySelector(".neato-tip").textContent = label;
    fillPicture(btn.querySelector(".neato-core"));
  } else {
    if (shape === "circle") btn.setAttribute("aria-label", label);
    else { var words = document.createElement("span"); words.textContent = label; btn.appendChild(words); }
    fillPicture(btn);
  }
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
    btn.classList.remove("peek");
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

  // The orb says hello once per visit, so a visitor on a phone (no hovering) still sees what it is for.
  if (orb) {
    var seen = false;
    try { seen = sessionStorage.getItem("neato-orb-" + agent) === "1"; } catch (e) { /* blocked: peek anyway */ }
    if (!seen) {
      setTimeout(function () {
        if (!panel.hidden) return;
        btn.classList.add("peek");
        try { sessionStorage.setItem("neato-orb-" + agent, "1"); } catch (e) { /* ignore */ }
        setTimeout(function () { btn.classList.remove("peek"); }, 4500);
      }, 3000);
    }
  }
})();
