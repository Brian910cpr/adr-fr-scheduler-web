var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// workers/api/index.ts
var j = /* @__PURE__ */ __name((s, b) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } }), "j");
var api_default = {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (req.method === "POST" && p === "/api/claim") {
      const data = await req.json();
      const { member_identifier, service_date, block, role, unit_id = "120", confirm = false } = data;
      const member = member_identifier ? await env.DB.prepare("SELECT * FROM members WHERE member_number=?1 OR full_name=?1").bind(String(member_identifier)).first() : null;
      await env.DB.prepare(
        `INSERT INTO call_log (source, member_number, full_name, action, unit_id, service_date, block, seat_role, result, verified, payload)
         VALUES ('web', ?1, ?2, 'claim', ?3, ?4, ?5, ?6, 'logged', ?7, ?8)`
      ).bind(
        member?.member_number ?? null,
        member?.full_name ?? (data.full_name ?? null),
        unit_id,
        service_date,
        block,
        role,
        member ? 1 : 0,
        JSON.stringify(data)
      ).run();
      const seat = await env.DB.prepare(
        "SELECT * FROM wallboard WHERE service_date=? AND block=? AND unit_id=? AND seat_role=?"
      ).bind(service_date, block, unit_id, role).first();
      if (seat && seat.status === "open" && member) {
        await env.DB.prepare(
          `UPDATE wallboard
           SET assignee_member_number=?1, status='confirmed', quality='green', flashing='none',
               notes=COALESCE(notes,'') || ' | web-claim'
           WHERE service_date=?2 AND block=?3 AND unit_id=?4 AND seat_role=?5`
        ).bind(member.member_number, service_date, block, unit_id, role).run();
        return j(200, { ok: true, assigned: true, message: "Confirmed. Thank you for stepping up!" });
      }
      await env.DB.prepare(
        `UPDATE wallboard SET status='standby', quality='grey'
         WHERE service_date=? AND block=? AND unit_id=? AND seat_role=?`
      ).bind(service_date, block, unit_id, role).run();
      return j(200, { ok: true, assigned: false, message: "Logged as standby. Shifts \u22653 weeks out show grey until Wednesday publish." });
    }
    if (req.method === "POST" && p === "/api/remove") {
      const data = await req.json();
      const { service_date, block, role, unit_id = "120" } = data;
      await env.DB.prepare(
        `UPDATE wallboard
         SET assignee_member_number=NULL, status='open', quality='red', flashing='red',
             notes=COALESCE(notes,'') || ' | web-remove'
         WHERE service_date=?1 AND block=?2 AND unit_id=?3 AND seat_role=?4`
      ).bind(service_date, block, unit_id, role).run();
      await env.DB.prepare(
        `INSERT INTO call_log (source, action, unit_id, service_date, block, seat_role, result, payload)
         VALUES ('web','remove',?1,?2,?3,?4,'logged',?5)`
      ).bind(unit_id, service_date, block, role, JSON.stringify(data)).run();
      return j(200, { ok: true, message: "Removed. Standby list will be contacted as needed." });
    }
    if (req.method === "GET" && p === "/api/wallboard") {
      const date = url.searchParams.get("date");
      const q = date ? await env.DB.prepare("SELECT * FROM wallboard WHERE service_date=? ORDER BY unit_id, seat_role").bind(date).all() : await env.DB.prepare("SELECT * FROM wallboard ORDER BY service_date, unit_id, seat_role").all();
      return j(200, { ok: true, rows: q.results });
    }
    return j(404, { ok: false, error: "Not found" });
  }
};

// C:/Users/ten77/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/ten77/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-FPWVAl/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = api_default;

// C:/Users/ten77/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-FPWVAl/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
