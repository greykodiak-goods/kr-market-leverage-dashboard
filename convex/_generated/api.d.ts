/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as dart from "../dart.js";
import type * as datasets from "../datasets.js";
import type * as http from "../http.js";
import type * as intraday from "../intraday.js";
import type * as lib_dartRadar from "../lib/dartRadar.js";
import type * as lib_intradayServe from "../lib/intradayServe.js";
import type * as ops from "../ops.js";
import type * as paper from "../paper.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  dart: typeof dart;
  datasets: typeof datasets;
  http: typeof http;
  intraday: typeof intraday;
  "lib/dartRadar": typeof lib_dartRadar;
  "lib/intradayServe": typeof lib_intradayServe;
  ops: typeof ops;
  paper: typeof paper;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
