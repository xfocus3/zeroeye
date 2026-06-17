/**
 * @fileoverview Native compatibility utilities retained for older imports.
 *
 * LEGACY NOTE: this module used to host migration shims and an unsafe
 * template path. It now exposes typed React/fetch helpers only.
 */

import { Fragment, createElement, isValidElement } from 'react';
import type { ReactNode } from 'react';

export type HeaderMap = Record<string, string>;
export type QueryParamValue = string | number | boolean | null | undefined;
export type TemplateContext = Record<string, unknown>;

export interface HttpResponseCache {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  remove?(key: string): void;
}

export interface HttpLegacyConfig {
  method: string;
  url: string;
  data?: unknown;
  params?: Record<string, QueryParamValue>;
  headers?: HeaderMap;
  timeout?: number;
  withCredentials?: boolean;
  responseType?: XMLHttpRequestResponseType;
  transformRequest?: Array<(data: unknown) => unknown>;
  transformResponse?: Array<(data: unknown) => unknown>;
  cache?: boolean | HttpResponseCache;
  xsrfHeaderName?: string;
  xsrfCookieName?: string;
}

export interface HttpLegacyResponse<T> {
  data: T;
  status: number;
  statusText: string;
  headers: () => HeaderMap;
  config: HttpLegacyConfig;
}

export interface HttpLegacyError {
  data: null;
  status: number;
  statusText: string;
  headers: () => HeaderMap;
  config: HttpLegacyConfig;
  error: unknown;
}

const TEMPLATE_TOKEN = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;

/**
 * Renders simple token templates as React nodes without code execution or HTML injection.
 *
 * LEGACY callers can keep using string templates, while React handles escaping
 * for text interpolation and can render React elements supplied in context.
 */
export function renderLegacyTemplate(
  template: string,
  context: TemplateContext = {}
): ReactNode {
  const children: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TEMPLATE_TOKEN.lastIndex = 0;
  while ((match = TEMPLATE_TOKEN.exec(template)) !== null) {
    if (match.index > lastIndex) {
      children.push(template.slice(lastIndex, match.index));
    }

    const value = getPathValue(context, match[1]);
    children.push(formatTemplateValue(value));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < template.length) {
    children.push(template.slice(lastIndex));
  }

  if (children.length === 0) {
    return '';
  }

  if (children.length === 1) {
    return children[0];
  }

  return createElement(Fragment, null, ...children);
}

export const renderTemplate = renderLegacyTemplate;

export async function $httpLegacy<T>(
  config: HttpLegacyConfig
): Promise<HttpLegacyResponse<T>> {
  const url = buildUrl(config.url, config.params);
  const headers = new Headers(config.headers ?? {});

  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json, text/plain, */*');
  }

  const controller = new AbortController();
  const timeoutId = config.timeout
    ? window.setTimeout(() => controller.abort(), config.timeout)
    : undefined;

  try {
    const body = buildRequestBody(config, headers);
    const response = await fetch(url, {
      method: config.method,
      headers,
      body,
      signal: controller.signal,
      credentials: config.withCredentials ? 'include' : 'same-origin',
    });

    const parsed = await readResponse(response, config.responseType);
    const transformed = applyTransforms(parsed, config.transformResponse);

    return {
      data: transformed as T,
      status: response.status,
      statusText: response.statusText,
      headers: () => headersToObject(response.headers),
      config,
    };
  } catch (error: unknown) {
    const statusText = error instanceof Error ? error.message : 'Unknown error';
    const compatError: HttpLegacyError = {
      data: null,
      status: -1,
      statusText,
      headers: () => ({}),
      config,
      error,
    };
    throw compatError;
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export function legacyToJson(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => (
    currentValue === undefined ? null : currentValue
  )) ?? 'null';
}

function buildUrl(url: string, params?: Record<string, QueryParamValue>): string {
  if (!params) {
    return url;
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      searchParams.append(key, String(value));
    }
  }

  const query = searchParams.toString();
  return query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url;
}

function buildRequestBody(config: HttpLegacyConfig, headers: Headers): BodyInit | undefined {
  if (config.data === undefined) {
    return undefined;
  }

  let body: unknown = isBodyInit(config.data) ? config.data : JSON.stringify(config.data);
  body = applyTransforms(body, config.transformRequest);

  const requestBody = isBodyInit(body) ? body : JSON.stringify(body);
  if (requestBody === undefined) {
    return undefined;
  }

  if (typeof requestBody === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json;charset=utf-8');
  }

  return requestBody;
}

function applyTransforms(value: unknown, transforms?: Array<(data: unknown) => unknown>): unknown {
  if (!transforms) {
    return value;
  }

  return transforms.reduce((current, transform) => transform(current), value);
}

async function readResponse(
  response: Response,
  responseType?: XMLHttpRequestResponseType
): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  if (responseType === 'blob') {
    return response.blob();
  }

  if (responseType === 'arraybuffer') {
    return response.arrayBuffer();
  }

  if (responseType === 'text') {
    return response.text();
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (responseType === 'json' || contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

function headersToObject(headers: Headers): HeaderMap {
  const result: HeaderMap = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function isBodyInit(value: unknown): value is BodyInit {
  return typeof value === 'string'
    || value instanceof ArrayBuffer
    || value instanceof URLSearchParams
    || value instanceof FormData
    || (typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream);
}

function getPathValue(context: TemplateContext, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!isRecord(current)) {
      return undefined;
    }

    return current[part];
  }, context);
}

function formatTemplateValue(value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return '';
  }

  if (isValidElement(value)) {
    return value;
  }

  if (value instanceof Date) {
    return value.toLocaleString();
  }

  if (Array.isArray(value)) {
    return value.map(item => formatTemplateValue(item));
  }

  if (isRecord(value)) {
    return JSON.stringify(value) ?? '';
  }

  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
