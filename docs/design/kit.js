/*
 * Kit compartilhado dos protótipos v0.3 (carregar DEPOIS do Tailwind Play CDN v3).
 *
 * Grade de 8 pontos: a escala de spacing é substituída, então `p-1` = 8px, `p-2` = 16px,
 * `h-7` = 56px etc. Só existem meios-passos de 4px (`0.5`, `1.5`, `2.5`) para ícones e
 * ajuste fino de alinhamento. Tamanhos de fonte têm altura de linha em múltiplos de 8.
 * Fontes: Helvetica Neue para títulos e texto; monoespaçada do sistema para metadados.
 */
(function () {
  const spacing = { px: "1px", 0: "0px", 0.5: "4px", 1.5: "12px", 2.5: "20px" };
  for (let n = 1; n <= 160; n++) spacing[n] = `${n * 8}px`;

  tailwind.config = {
    theme: {
      spacing,
      fontFamily: {
        sans: ['"Helvetica Neue"', "Helvetica", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        xs: ["12px", "16px"],
        sm: ["14px", "24px"],
        base: ["16px", "24px"],
        lg: ["18px", "24px"],
        xl: ["20px", "32px"],
        "2xl": ["24px", "32px"],
      },
      colors: {
        transparent: "transparent",
        current: "currentColor",
        black: "#000000",
        bg: "#2c2f27",
        panel: "#33362d",
        raised: "#3b3f33",
        line: "#4b4f43",
        ink: "#ecebe3",
        muted: "#b5b4a8",
        faint: "#86887a",
        accent: { DEFAULT: "#a8c47e", ink: "#1d2414" },
        warn: "#e0a344",
        danger: "#d9725a",
      },
      extend: {},
    },
  };

  // Ícones de traço (estilo Lucide), desenhados inline para o protótipo não depender de pacote.
  const I = {
    feather: '<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" fill="currentColor" fill-opacity=".9"/><path d="M16 8 2 22M17.5 15H9"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    "user-circle": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.7a6 6 0 0 1 10 0"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    "chev-l": '<path d="m15 18-6-6 6-6"/>',
    "chev-r": '<path d="m9 18 6-6-6-6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    "eye-off": '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/></g>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    "arrow-up-right": '<path d="M7 17 17 7M7 7h10v10"/>',
    "arrow-right": '<path d="M5 12h14M12 5l7 7-7 7"/>',
    enter: '<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
  };

  window.hydrateIcons = function (root = document) {
    root.querySelectorAll("i[data-icon]").forEach((el) => {
      if (el.dataset.done) return;
      el.dataset.done = "1";
      el.classList.add("inline-block", "shrink-0");
      el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%">${I[el.dataset.icon] || ""}</svg>`;
    });
  };
  document.addEventListener("DOMContentLoaded", () => window.hydrateIcons());
})();
