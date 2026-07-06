(() => {
  const repository = "seledoz/Blue-min";
  const ref = "main";
  const rawBaseUrl = `https://raw.githubusercontent.com/${repository}/${ref}`;
  const sourceFiles = [
    "src/core.js",
    "src/modules/pz.js",
    "src/modules/xray.js",
    "src/modules/panic.js",
    "src/modules/rune.js",
    "src/modules/heal.js",
    "src/modules/auto-invisible.js",
    "src/modules/auto-magic-shield.js",
    "src/modules/auto-attack.js",
    "src/modules/auto-attack-aoe.js",
    "src/modules/cave.js",
    "src/modules/equip-ring.js",
    "src/modules/auto-eat.js",
    "src/modules/auto-fishing.js",
    "src/modules/talk.js",
    "src/ui/panel.js",
    "src/main.js",
  ];

  async function loadSourceFile(path) {
    const response = await fetch(`${rawBaseUrl}/${path}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load ${path}: HTTP ${response.status}`);
    }

    const code = await response.text();
    window.eval(`\n//# sourceURL=${rawBaseUrl}/${path}\n${code}`);
  }

  async function loadBot() {
    console.log("[minibia-bot] loading bundle", { repository, ref });
    window.__minibiaBotBundle = {};

    for (const file of sourceFiles) {
      await loadSourceFile(file);
    }
  }

  loadBot().catch((error) => {
    console.error("[minibia-bot] failed to load bundle", error);
  });
})();
