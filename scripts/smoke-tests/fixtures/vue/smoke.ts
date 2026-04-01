import { JSDOM } from "jsdom";

// Set up DOM globals BEFORE importing Vue (Vue caches document at import time)
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  Element: dom.window.Element,
  MutationObserver: dom.window.MutationObserver,
});

// Dynamic imports so Vue sees the DOM globals
const { createApp, defineComponent, h, onMounted, ref } = await import("vue");
const { schmock } = await import("@schmock/core");
const { schmockPlugin, useSchmock } = await import("@schmock/vue");

// 1. Verify exports
if (typeof schmockPlugin !== "object") throw new Error("schmockPlugin not an object");
if (typeof useSchmock !== "function") throw new Error("useSchmock not a function");

// 2. Test plugin installs and intercepts
const mock = schmock();
mock("GET /api/items", [{ id: 1, name: "Widget" }]);
mock("POST /api/items", ({ body }) => [201, body]);

const App = defineComponent({
  setup() {
    const items = ref<Array<{ id: number; name: string }>>([]);
    const hasMock = ref(false);

    try {
      const m = useSchmock();
      hasMock.value = !!m;
    } catch {
      // expected if no plugin
    }

    onMounted(async () => {
      const res = await fetch("http://localhost/api/items");
      items.value = await res.json();
    });

    return () =>
      h("div", { id: "app" }, [
        h("span", { id: "count" }, String(items.value.length)),
        h("span", { id: "has-mock" }, hasMock.value ? "yes" : "no"),
        ...items.value.map((i) =>
          h("span", { class: "item", key: i.id }, i.name),
        ),
      ]);
  },
});

const container = document.createElement("div");
document.body.appendChild(container);

const app = createApp(App);
app.use(schmockPlugin, { mock });
app.mount(container);

// Wait for mount + fetch
await new Promise((r) => setTimeout(r, 100));

// Verify rendering
const count = container.querySelector("#count");
if (count?.textContent !== "1") throw new Error("Fetch not intercepted, count: " + count?.textContent);

const hasMock = container.querySelector("#has-mock");
if (hasMock?.textContent !== "yes") throw new Error("useSchmock failed");

const item = container.querySelector(".item");
if (item?.textContent !== "Widget") throw new Error("Item not rendered: " + item?.textContent);

// Spy
if (!mock.called("GET", "/api/items")) throw new Error("spy: should be called");

// POST works too
const postRes = await fetch("http://localhost/api/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Gadget" }),
});
if (postRes.status !== 201) throw new Error("POST status: " + postRes.status);
const posted = await postRes.json();
if (posted.name !== "Gadget") throw new Error("POST body wrong");

// Cleanup
app.unmount();

console.log("@schmock/vue: all checks passed");
