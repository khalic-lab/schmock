// schmock.config.ts - Your project's mock configuration
import { Schmock } from "@schmock/core";
import { constraints } from "@schmock/plugin-constraints";
import { query } from "@schmock/plugin-query";
import { schema } from "@schmock/plugin-schema";
import { state } from "@schmock/plugin-state";

// Step 1: Create Schmock instance with basic routes
const schmock = new Schmock({
  routes: {
    "/api/users": "./schemas/user.json",
    "/api/products": "./schemas/product.json",
    "/api/orders": "./schemas/order.json",
    "/api/order-items": "./schemas/order-item.json",
  },
});

// Step 2: Add schema validation and generation
schmock.use(
  schema({
    // Use faker for better fake data
    faker: true,
    // Add custom formats
    formats: {
      "company-email": (name: string) =>
        `${name.toLowerCase().replace(/\s+/g, ".")}@acme.com`,
    },
  }),
);

// Step 3: Add business constraints
schmock.use(
  constraints({
    "/api/products": {
      fields: {
        price: ({ record }) => {
          const basePrice = record.category === "premium" ? 100 : 10;
          const variance = faker.number.float({ min: 0.8, max: 1.2 });
          return Math.round(basePrice * variance * 100) / 100;
        },
        stock: ({ record }) => {
          // Premium products have lower stock
          return record.category === "premium"
            ? faker.number.int({ min: 0, max: 50 })
            : faker.number.int({ min: 100, max: 1000 });
        },
      },
    },

    "/api/orders": {
      fields: {
        userId: ({ db }) => db.randomId("users"),
        orderDate: () => faker.date.recent({ days: 30 }),
        status: ({ record }) => {
          const age = Date.now() - record.orderDate.getTime();
          const days = age / (1000 * 60 * 60 * 24);

          if (days < 1) return "pending";
          if (days < 3)
            return faker.helpers.arrayElement(["processing", "shipped"]);
          return "delivered";
        },
        total: ({ record, db }) => {
          const items = db.query("order-items", { orderId: record.id });
          return items.reduce(
            (sum, item) => sum + item.quantity * item.unitPrice,
            0,
          );
        },
      },

      afterCreate: ({ record, db }) => {
        // Create 1-5 order items for each order
        const itemCount = faker.number.int({ min: 1, max: 5 });

        for (let i = 0; i < itemCount; i++) {
          const product = db.random("products");
          db.create("order-items", {
            orderId: record.id,
            productId: product.id,
            quantity: faker.number.int({ min: 1, max: 5 }),
            unitPrice: product.price,
          });

          // Update product stock
          db.update("products", product.id, {
            stock: Math.max(0, product.stock - quantity),
          });
        }
      },
    },

    "/api/users": {
      fields: {
        email: ({ record }) => {
          const { firstName, lastName } = record;
          return `${firstName}.${lastName}@acme.com`.toLowerCase();
        },
        role: () =>
          faker.helpers.weightedArrayElement([
            { weight: 70, value: "user" },
            { weight: 20, value: "admin" },
            { weight: 10, value: "superadmin" },
          ]),
      },
    },
  }),
);

// Step 4: Add stateful behavior
schmock.use(
  state({
    adapter: "sqlite",
    database: process.env.NODE_ENV === "test" ? ":memory:" : "./dev-data.db",

    relationships: {
      "/api/orders": {
        belongsTo: {
          user: { path: "/api/users", key: "userId" },
        },
        hasMany: {
          items: { path: "/api/order-items", key: "orderId" },
        },
      },
      "/api/order-items": {
        belongsTo: {
          order: { path: "/api/orders", key: "orderId" },
          product: { path: "/api/products", key: "productId" },
        },
      },
    },

    // Seed initial data on first run
    seed: {
      users: 50,
      products: 200,
      orders: 500,
    },
  }),
);

// Step 5: Add query capabilities
schmock.use(
  query({
    "/api/users": {
      filterable: ["role", "email", "createdAt"],
      sortable: ["name", "email", "createdAt"],
      searchable: ["name", "email"],
      paginate: { defaultLimit: 20 },
    },

    "/api/products": {
      filterable: ["category", "price", "stock"],
      sortable: ["name", "price", "stock"],
      searchable: ["name", "description"],
      paginate: { defaultLimit: 50 },

      // Custom filters
      customFilters: {
        inStock: (q) => q.where("stock", ">", 0),
        premium: (q) => q.where("category", "=", "premium"),
        priceRange: (q, [min, max]) => q.whereBetween("price", [min, max]),
      },
    },

    "/api/orders": {
      filterable: ["status", "userId", "orderDate", "total"],
      sortable: ["orderDate", "total", "status"],
      paginate: { defaultLimit: 25 },
      include: ["user", "items.product"], // Eager loading

      // Aggregation endpoint
      aggregations: {
        "/api/orders/stats": {
          groupBy: ["status", "date:orderDate", "userId"],
          metrics: ["count", "sum:total", "avg:total"],
        },
      },
    },
  }),
);

// Step 6: Add custom plugin for logging
schmock.use({
  name: "schmock-logger",
  version: "1.0.0",

  beforeRequest({ method, path, query, body }) {
    console.log(`📥 ${method} ${path}`, { query, body });
  },

  afterGenerate({ path }, data) {
    console.log(
      `📤 ${path} generated ${Array.isArray(data) ? data.length : 1} records`,
    );
    return data;
  },

  onError({ error, path }) {
    console.error(`❌ Error on ${path}:`, error);
  },
});

export default schmock;

// Usage in Angular
// app.config.ts
import { provideSchmock } from "@schmock/angular";
import schmock from "./schmock.config";

export const appConfig = {
  providers: [provideSchmock(schmock)],
};

import { toMSW } from "@schmock/msw";
// Usage with MSW (React/Vue/Svelte)
// mock-server.ts
import { setupWorker } from "msw";
import schmock from "./schmock.config";

export const worker = setupWorker(...toMSW(schmock));

import { middleware } from "@schmock/express";
// Usage with Express
// server.ts
import express from "express";
import schmock from "./schmock.config";

const app = express();
app.use("/api", middleware(schmock));

// Usage in tests
// order.test.ts
import { createTestSchmock } from "@schmock/testing";
import config from "./schmock.config";

describe("Order API", () => {
  let schmock: TestSchmock;

  beforeEach(() => {
    schmock = createTestSchmock(config);
  });

  it("should create order and update stock", async () => {
    // Seed specific test data
    const product = await schmock.create("/api/products", {
      name: "Test Product",
      stock: 10,
      price: 99.99,
    });

    const order = await schmock.create("/api/orders", {
      items: [
        {
          productId: product.id,
          quantity: 3,
        },
      ],
    });

    // Verify stock was updated
    const updatedProduct = await schmock.get(`/api/products/${product.id}`);
    expect(updatedProduct.stock).toBe(7);

    // Verify order total
    expect(order.total).toBe(299.97);
  });
});
