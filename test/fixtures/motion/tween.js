// A small stand-in for GSAP + ScrollTrigger, shaped like the real globals so
// rpc's guarded --finish-animations path has something to find: tweens that
// write inline styles on every animation frame, `gsap.globalTimeline
// .getChildren()`, and `ScrollTrigger.getAll()` / `create({ pin })` that wraps
// the pinned element in a `.pin-spacer` with padding below it, fixes it
// while active and offsets it at the end, as ScrollTrigger does.
(() => {
  const active = [];
  const triggers = [];
  const ease = t => 1 - Math.pow(1 - t, 3);

  function paint(el, from, to, p) {
    const e = ease(p);
    el.style.opacity = String(from.opacity + (to.opacity - from.opacity) * e);
    el.style.transform = 'translate(0px, ' + (from.y + (to.y - from.y) * e) + 'px)';
  }

  function Tween(el, from, to) {
    this.vars = to;
    this.scrollTrigger = to.scrollTrigger;
    this._p = 0;
    this._start = performance.now() + (to.delay || 0) * 1000;
    this._paint = p => paint(el, from, to, p);
    this._paint(0);
    active.push(this);
  }
  Tween.prototype.progress = function (v) {
    if (v === undefined) return this._p;
    this._p = Math.min(1, Math.max(0, v));
    this._paint(this._p);
    if (this._p >= 1) {
      const i = active.indexOf(this);
      if (i >= 0) active.splice(i, 1); // the global timeline drops finished tweens
    }
    return this;
  };
  Tween.prototype.repeat = function () {
    return this.vars.repeat || 0;
  };

  function frame(now) {
    for (const t of active.slice()) {
      if (now < t._start) continue;
      t.progress((now - t._start) / (t.vars.duration * 1000));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.gsap = {
    fromTo: (el, from, to) => new Tween(el, from, to),
    globalTimeline: { getChildren: () => active.slice() },
  };

  window.ScrollTrigger = {
    getAll: () => triggers.slice(),
    create(vars) {
      const el = vars.trigger;
      const distance = vars.distance;
      const spacer = document.createElement('div');
      spacer.className = 'pin-spacer';
      el.parentNode.insertBefore(spacer, el);
      spacer.appendChild(el);
      const st = { vars, pin: el, spacer, animation: vars.animation };
      triggers.push(st);
      const update = () => {
        const h = el.offsetHeight;
        spacer.style.cssText = 'box-sizing: border-box; height: ' + (h + distance) + 'px; padding: 0px 0px ' + distance + 'px;';
        const start = spacer.getBoundingClientRect().top + window.scrollY;
        const y = window.scrollY - start;
        if (y > 0 && y < distance) {
          el.style.cssText = 'position: fixed; top: 0px; left: 0px; width: ' + spacer.offsetWidth + 'px; height: ' + h + 'px; transform: none;';
        } else {
          el.style.cssText = 'position: relative; transform: translate(0px, ' + (y >= distance ? distance : 0) + 'px);';
        }
        if (vars.onUpdate) vars.onUpdate(Math.min(1, Math.max(0, y / distance)));
      };
      window.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      update();
      return st;
    },
  };
})();
