// Request validation with zod. Parsed values land on req.valid.{body,query,params} — handlers read
// from there and never from the raw request.
import { AppError } from '../lib/errors.js';

export function zodFieldErrors(error) {
  const fields = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

/**
 * validate({ body: zodSchema, query: zodSchema, params: zodSchema })
 */
export function validate(schemas) {
  function validator(req, res, next) {
    req.valid ??= {};
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const input = part === 'body' ? (req.body ?? {}) : req[part];
      const result = schema.safeParse(input);
      if (!result.success) {
        const fields = zodFieldErrors(result.error);
        const first = Object.entries(fields)[0];
        const message =
          part === 'body'
            ? 'Please correct the highlighted fields.'
            : `Invalid request${first ? `: ${first[0] === '_' ? '' : `${first[0]} — `}${first[1]}` : ''}`;
        throw new AppError(422, 'VALIDATION_ERROR', message, { fields, in: part });
      }
      req.valid[part] = result.data;
    }
    return next();
  }
  // Kept for the API reference generator (scripts/generate-api-docs.js).
  validator.schemas = schemas;
  return validator;
}
