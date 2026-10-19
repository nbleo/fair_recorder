/* 点击反馈回归测试：按下有缩放/涟漪、异步有转圈与顶部进度条、忙碌时不被连点穿透。
 *
 *   NODE_PATH=<node workspace>/node_modules node tests/e2e_tap_feedback.js [baseUrl]
 */
const puppeteer = require("puppeteer");

const BASE = process.argv[2] || "http://127.0.0.1:8765/index.html";

const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); process.exitCode = 1; };
const check = (c, m) => (c ? ok(m) : bad(m));

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(BASE, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 20000 });

  // 1) 顶部进度条存在且默认隐藏
  const bar0 = await page.evaluate(() => {
    const b = document.getElementById("workbar");
    return { exists: !!b, on: b ? b.classList.contains("on") : null };
  });
  check(bar0.exists, "#workbar 已渲染");
  check(bar0.on === false, "空闲时不显示进度条");

  // 2) pointerdown 立刻出现按下态 + 涟漪
  const down = await page.evaluate(() => {
    const el = document.getElementById("btnQuick");
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: r.left + 12, clientY: r.top + 12,
    }));
    const res = {
      pressed: el.classList.contains("pressed"),
      ripple: !!el.querySelector(".ripple"),
    };
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    return res;
  });
  check(down.pressed, "按下瞬间就打上 .pressed（缩放 + 提亮）");
  check(down.ripple, "按下瞬间生成涟漪");

  // 3) 松开后自动复位
  await new Promise((r) => setTimeout(r, 700));
  const up = await page.evaluate(() => ({
    pressed: document.getElementById("btnQuick").classList.contains("pressed"),
    ripple: !!document.querySelector("#btnQuick .ripple"),
  }));
  check(!up.pressed, "松开后 .pressed 自动移除");
  check(!up.ripple, "涟漪动画结束后被清理（不留 DOM）");

  // 4) 异步 onclick 自动进入忙碌态：转圈 + 顶部进度条
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "tAsync"; b.className = "btn"; b.textContent = "测试异步";
    b.onclick = async () => { await new Promise((r) => setTimeout(r, 700)); };
    document.querySelector("main").appendChild(b);
  });
  await page.evaluate(() => document.getElementById("tAsync").click());
  await new Promise((r) => setTimeout(r, 60));
  const busy1 = await page.evaluate(() => {
    const b = document.getElementById("tAsync");
    return {
      busy: b.classList.contains("is-busy"),
      aria: b.getAttribute("aria-busy"),
      spin: !!b.querySelector(".spin"),
      bar: document.getElementById("workbar").classList.contains("on"),
    };
  });
  check(busy1.busy, "异步按钮进入 .is-busy");
  check(busy1.aria === "true", "aria-busy=true（读屏可感知）");
  check(busy1.spin, "按钮内出现转圈指示");
  check(busy1.bar, "顶部进度条亮起");

  // 5) 忙碌期间连点不再触发第二次（先等上一轮结束，避免命中上一轮的忙碌态）
  await new Promise((r) => setTimeout(r, 800));
  const dup = await page.evaluate(() => {
    const b = document.getElementById("tAsync");
    let n = 0;
    b.onclick = async () => { n++; await new Promise((r) => setTimeout(r, 300)); };
    b.click(); b.click(); b.click();
    return n;
  });
  check(dup === 1, `忙碌中连点只执行一次（实际 ${dup} 次）`);

  // 6) 结束后自动恢复
  await new Promise((r) => setTimeout(r, 1200));
  const after = await page.evaluate(() => {
    const b = document.getElementById("tAsync");
    return {
      busy: b.classList.contains("is-busy"),
      spin: !!b.querySelector(".spin"),
      bar: document.getElementById("workbar").classList.contains("on"),
    };
  });
  check(!after.busy, "promise 结束后自动解除忙碌态");
  check(!after.spin, "转圈元素被移除");
  check(!after.bar, "进度条自动收起");

  // 7) 同步 onclick 不受影响：返回值、this、事件都照常
  const compat = await page.evaluate(() => {
    const b = document.createElement("button");
    b.className = "btn"; document.querySelector("main").appendChild(b);
    let got = null;
    b.onclick = function (ev) { got = { self: this === b, ev: !!ev, ret: 7 }; return 7; };
    const ret = b.click();
    return { got, ret };
  });
  check(compat.got && compat.got.self, "包装后 this 仍指向按钮");
  check(compat.got && compat.got.ev, "包装后事件对象仍传入");
  check(compat.got && compat.got.ret === 7, "包装后返回值不变");

  // 8) 真实页面按钮：内联 onclick 也有按下反馈
  const inline = await page.evaluate(() => {
    go("fairs");
    const el = document.getElementById("btnFairNew");
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left + 8, clientY: r.top + 8 }));
    const pressed = el.classList.contains("pressed");
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    return pressed;
  });
  check(inline, "内联 onclick 按钮同样有按下反馈");

  await browser.close();

  console.log("");
  if (errors.length) {
    console.log("页面错误：");
    errors.slice(0, 10).forEach((e) => console.log("   " + e));
    process.exitCode = 1;
  } else {
    console.log("无 JS 运行时错误");
  }
})().catch((e) => { console.error("tap feedback test failed:", e); process.exit(1); });
