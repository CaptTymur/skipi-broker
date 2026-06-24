(function(){
  "use strict";
  // host-check — bundled first-party fixture plugin for Skipi Broker (and any
  // Skipi home). Proves the host correctly mounts a plugin and exposes ONLY the
  // narrow hostApi. No network, no documents, no account, no analytics.
  var manifest = { id: "app.skipi.plugins.host-check", slug: "host-check",
                   name: "Проверка хоста", version: "0.1.0" };
  var _unsubTheme = null;

  function el(tag, css, txt){
    var e = document.createElement(tag);
    if(css) e.style.cssText = css;
    if(txt != null) e.textContent = txt;
    return e;
  }

  window.SkipiPlugins = window.SkipiPlugins || {};
  window.SkipiPlugins["host-check"] = {
    manifest: manifest,
    mount: function(container, host){
      if(host && host.navigation && host.navigation.setTitle) host.navigation.setTitle("Проверка хоста");
      var root = el("div", "padding:16px; font-size:13px; color:var(--text,#222);");
      root.appendChild(el("div", "font-weight:600; font-size:14px; margin-bottom:10px;",
                          "🧩 Проверка хоста — плагин смонтирован"));

      // theme.get + theme.subscribe
      var themeLine = el("div", "margin:4px 0;");
      function paintTheme(t){ themeLine.textContent = "Тема хоста: " + t; }
      paintTheme(host && host.theme ? host.theme.get() : "—");
      if(host && host.theme && host.theme.subscribe){ _unsubTheme = host.theme.subscribe(paintTheme); }
      root.appendChild(themeLine);

      // storage.get / storage.set (namespaced by host, plugin only sees its own)
      var n = 1;
      if(host && host.storage){
        n = (parseInt(host.storage.get("opens") || "0", 10) || 0) + 1;
        host.storage.set("opens", n);
      }
      root.appendChild(el("div", "margin:4px 0;", "Локальное хранилище плагина: открытий = " + n));

      // permissions.listGranted
      var granted = (host && host.permissions && host.permissions.listGranted)
        ? host.permissions.listGranted("host-check") : [];
      root.appendChild(el("div", "margin:4px 0; opacity:.8;",
                          "Выданные разрешения: " + (granted.join(", ") || "—")));

      root.appendChild(el("div", "margin:10px 0; font-size:11px; opacity:.7;",
        "Демо-плагин. Без сети и без доступа к почте, аккаунту и данным базара."));

      var btn = el("button", null, "Закрыть плагин");
      btn.className = "btn";
      btn.onclick = function(){ if(host && host.navigation && host.navigation.closePlugin) host.navigation.closePlugin(); };
      root.appendChild(btn);

      container.appendChild(root);
    },
    unmount: function(){
      if(_unsubTheme){ try { _unsubTheme(); } catch(_){} _unsubTheme = null; }
    }
  };
})();
