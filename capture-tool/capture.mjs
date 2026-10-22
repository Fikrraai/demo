import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ORIGIN = process.env.TARGET || "https://davinci.ai";
const OUT = "capture-out";
fs.mkdirSync(OUT, { recursive: true });

const slug = (u) => u.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 80) || "home";

// In-page extractor: computed style signature for every visible element.
const extract = () => {
  const pick = (el, cs) => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.getAttribute("class") || "").slice(0, 120),
    text: (el.children.length === 0 ? (el.textContent || "").trim().slice(0, 60) : ""),
    rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)]; })(),
    ff: cs.fontFamily.slice(0, 80), fs: cs.fontSize, fw: cs.fontWeight, lh: cs.lineHeight, ls: cs.letterSpacing, ta: cs.textAlign,
    color: cs.color, bg: cs.backgroundColor, bgi: cs.backgroundImage.slice(0, 160),
    br: cs.borderRadius, bd: cs.border, bs: cs.boxShadow.slice(0, 200),
    pad: cs.padding, mar: cs.margin, disp: cs.display, gap: cs.gap, pos: cs.position, op: cs.opacity, bf: cs.backdropFilter, tr: cs.transition.slice(0, 120),
  });
  const out = [];
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const t = el.tagName.toLowerCase();
    const interesting = /^(h[1-6]|p|a|button|input|textarea|select|nav|header|footer|section|main|li|img|video|label|span|svg)$/.test(t) || cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.boxShadow !== "none" || cs.borderRadius !== "0px";
    if (!interesting) continue;
    out.push(pick(el, cs));
    if (out.length > 2500) break;
  }
  const root = getComputedStyle(document.documentElement);
  const vars = {};
  for (const sheet of document.styleSheets) {
    try { for (const rule of sheet.cssRules) { if (rule.selectorText === ":root" || rule.selectorText === "html" || rule.selectorText === ".dark" || rule.selectorText === "body") { for (const p of rule.style) if (p.startsWith("--")) vars[p] = rule.style.getPropertyValue(p).trim(); } } } catch {}
  }
  return { title: document.title, bodyBg: getComputedStyle(document.body).backgroundColor, bodyFont: getComputedStyle(document.body).fontFamily, htmlFs: root.fontSize, vars, els: out };
};

const browser = await chromium.launch();
const seen = new Set();
const queue = [ORIGIN + "/"];
const links = new Set();
const results = [];

async function visit(url, vp, label) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, userAgent: label === "m" ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" : undefined, isMobile: label === "m" });
  const page = await ctx.newPage();
  const fonts = new Set();
  page.on("response", (r) => { const u = r.url(); if (/\.(woff2?|ttf|otf)(\?|$)/i.test(u)) fonts.add(u); });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  } catch (e) { console.log("goto fail", url, String(e).slice(0, 120)); }
  await page.waitForTimeout(2500);
  // scroll to trigger lazy content
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < Math.min(h, 14000); y += 600) { await page.evaluate((yy) => window.scrollTo(0, yy), y); await page.waitForTimeout(250); }
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(600);
  const s = slug(url) + "_" + label;
  try { await page.screenshot({ path: path.join(OUT, s + ".png"), fullPage: true, timeout: 60000 }); } catch (e) { console.log("shot fail", s); }
  try { await page.screenshot({ path: path.join(OUT, s + "_fold.png"), fullPage: false }); } catch {}
  let data = null;
  try { data = await page.evaluate(extract); } catch (e) { console.log("extract fail", s); }
  if (label === "d") {
    const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href));
    hrefs.forEach((h) => links.add(h));
  }
  if (data) fs.writeFileSync(path.join(OUT, s + ".json"), JSON.stringify({ url, fonts: [...fonts], ...data }));
  await ctx.close();
  return fonts;
}

let n = 0;
while (queue.length && n < 14) {
  const u = queue.shift();
  const key = u.split("#")[0].replace(/\/$/, "");
  if (seen.has(key)) continue;
  seen.add(key); n++;
  console.log("visit", u);
  await visit(u, { width: 1440, height: 900 }, "d");
  await visit(u, { width: 390, height: 844 }, "m");
  // enqueue same-site links (incl. subdomains) once from the home
  if (n === 1) {
    const host = new URL(ORIGIN).hostname.replace(/^www\./, "");
    const cand = [...links].filter((l) => { try { const x = new URL(l); return x.hostname.endsWith(host) && !/\.(png|jpg|svg|pdf|webp|mp4)$/i.test(x.pathname); } catch { return false; } });
    const uniq = [...new Set(cand.map((c) => c.split("#")[0]))];
    fs.writeFileSync(path.join(OUT, "links.json"), JSON.stringify(uniq, null, 1));
    // prioritise shallow paths
    uniq.sort((a, b) => new URL(a).pathname.split("/").length - new URL(b).pathname.split("/").length);
    queue.push(...uniq);
  }
}
await browser.close();
console.log("done", n);
