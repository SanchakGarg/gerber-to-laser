// Colour themes: a dropdown in the masthead corner, each option showing its inks as tiny boxes.
// The choice is kept in localStorage; index.html applies it before first paint so a reload opens
// straight into the saved theme. The colours themselves live in styles/themes.css.
import { readInk } from "./palette";

export interface Theme {
  id: string;
  name: string;
}

export const THEMES: Theme[] = [
  { id: "riso", name: "Riso" },
  { id: "newsprint", name: "Newsprint" },
  { id: "mint", name: "Mint" },
  { id: "peach", name: "Peach" },
  { id: "forest", name: "Forest" },
  { id: "lavender", name: "Lavender" },
  { id: "blueprint", name: "Blueprint" },
  { id: "midnight", name: "Midnight" },
  { id: "terminal", name: "Terminal" },
  { id: "ember", name: "Ember" },
];

/** Same key as the inline script in index.html. */
const KEY = "g2l.theme";
const SWATCH_VARS = ["--paper", "--ink", "--blue", "--pink", "--yellow", "--green", "--orange"];

const listeners: (() => void)[] = [];

export function currentTheme(): string {
  const id = document.documentElement.dataset.theme;
  return THEMES.some((t) => t.id === id) ? id! : "riso";
}

export function onThemeChange(fn: () => void) {
  listeners.push(fn);
}

export function setTheme(id: string) {
  if (!THEMES.some((t) => t.id === id)) id = "riso";
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode: the theme just won't be remembered */
  }
  syncMeta();
  for (const fn of listeners) fn();
}

function syncMeta() {
  readInk();
  const paper = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", paper);
}

function swatch(id: string) {
  const s = document.createElement("span");
  s.className = "tswatch";
  s.dataset.theme = id;
  s.setAttribute("aria-hidden", "true");
  for (const v of SWATCH_VARS) {
    const i = document.createElement("i");
    i.style.background = `var(${v})`;
    s.append(i);
  }
  return s;
}

/** Builds the picker into `host`. */
export function initThemePicker(host: HTMLElement) {
  syncMeta();

  const wrap = document.createElement("div");
  wrap.className = "theme-pick";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");

  const menu = document.createElement("ul");
  menu.className = "theme-menu";
  menu.id = "theme-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Theme");
  menu.tabIndex = -1;
  menu.hidden = true;
  btn.setAttribute("aria-controls", menu.id);

  const opts = THEMES.map((t) => {
    const li = document.createElement("li");
    li.className = "theme-opt";
    li.id = `theme-opt-${t.id}`;
    li.setAttribute("role", "option");
    li.dataset.id = t.id;
    const name = document.createElement("span");
    name.className = "tname";
    name.textContent = t.name;
    li.append(name, swatch(t.id));
    li.addEventListener("click", () => choose(t.id));
    li.addEventListener("mousemove", () => highlight(THEMES.indexOf(t)));
    menu.append(li);
    return li;
  });

  let active = 0;
  const renderButton = () => {
    const id = currentTheme();
    const t = THEMES.find((x) => x.id === id)!;
    const label = document.createElement("span");
    label.className = "tlabel";
    label.textContent = t.name;
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▾";
    btn.replaceChildren(swatch(id), label, caret);
    btn.setAttribute("aria-label", `Theme: ${t.name}`);
    for (const li of opts) li.setAttribute("aria-selected", String(li.dataset.id === id));
  };

  const highlight = (i: number) => {
    active = (i + opts.length) % opts.length;
    opts.forEach((li, j) => li.classList.toggle("active", j === active));
    menu.setAttribute("aria-activedescendant", opts[active].id);
    opts[active].scrollIntoView({ block: "nearest" });
  };

  const open = () => {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    highlight(THEMES.findIndex((t) => t.id === currentTheme()));
    menu.focus();
  };
  const close = (focusBtn = true) => {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (focusBtn) btn.focus();
  };
  const choose = (id: string) => {
    setTheme(id);
    renderButton();
    close();
  };

  btn.addEventListener("click", () => (menu.hidden ? open() : close()));
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open();
    }
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") highlight(active + 1);
    else if (e.key === "ArrowUp") highlight(active - 1);
    else if (e.key === "Home") highlight(0);
    else if (e.key === "End") highlight(opts.length - 1);
    else if (e.key === "Enter" || e.key === " ") choose(THEMES[active].id);
    else if (e.key === "Escape") close();
    else {
      if (e.key === "Tab") close(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!wrap.contains(e.target as Node)) close(false);
  });

  renderButton();
  wrap.append(btn, menu);
  host.append(wrap);
}
