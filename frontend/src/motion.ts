// Playful motion, all of it skipped when the user prefers reduced motion.

const INKS = ["#ff48b0", "#0078bf", "#ffe800", "#00a95c", "#ff6c2f", "#1d1d1b"];

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Little PCB bits (pads, vias, trace stubs) bursting out of a point, e.g. a clicked download. */
export function burst(x: number, y: number, count = 26) {
  if (reducedMotion()) return;
  const layer = document.createElement("div");
  layer.className = "confetti";
  document.body.append(layer);
  for (let i = 0; i < count; i++) {
    const bit = document.createElement("i");
    const kind = i % 3;
    bit.className = `bit bit-${kind}`;
    bit.style.setProperty("--c", INKS[i % INKS.length]);
    bit.style.left = `${x}px`;
    bit.style.top = `${y}px`;
    layer.append(bit);
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const dist = 70 + Math.random() * 110;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 60;
    const spin = (Math.random() - 0.5) * 720;
    bit.animate(
      [
        { transform: "translate(-50%, -50%) rotate(0deg) scale(0.4)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${spin / 2}deg) scale(1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + 140}px)) rotate(${spin}deg) scale(0.9)`, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 500, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" },
    );
  }
  window.setTimeout(() => layer.remove(), 1600);
}

/** Stagger children in with the CSS `.stamp-in` animation. */
export function stampIn(parent: Element, selector = ":scope > *") {
  if (reducedMotion()) return;
  parent.querySelectorAll<HTMLElement>(selector).forEach((el, i) => {
    el.style.setProperty("--i", String(i));
    el.classList.remove("stamp-in");
    void el.offsetWidth;
    el.classList.add("stamp-in");
  });
}

/** A one-off CSS animation class (removed when it ends, so it can be replayed). */
export function flash(el: Element, cls: string) {
  if (reducedMotion()) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}
