// Spec 6.3: anchors that are too common to show the agent used a specific read. 200 words, lowercase.

export const STOPLIST: ReadonlySet<string> = new Set([
  'data', 'name', 'type', 'value', 'this', 'self', 'true', 'false', 'null', 'none',
  'return', 'default', 'props', 'test', 'config', 'args', 'argv', 'opts', 'options', 'params',
  'param', 'result', 'results', 'error', 'errors', 'item', 'items', 'list', 'array', 'object',
  'string', 'number', 'boolean', 'index', 'keys', 'main', 'init', 'start', 'stop', 'load',
  'save', 'read', 'write', 'open', 'close', 'file', 'files', 'path', 'paths', 'text',
  'content', 'body', 'title', 'label', 'input', 'output', 'state', 'status', 'info', 'message',
  'event', 'events', 'handler', 'callback', 'context', 'request', 'response', 'client', 'server', 'user',
  'users', 'model', 'models', 'view', 'views', 'node', 'nodes', 'child', 'children', 'parent',
  'root', 'base', 'temp', 'util', 'utils', 'helper', 'helpers', 'common', 'core', 'shared',
  'types', 'interface', 'class', 'struct', 'function', 'method', 'module', 'package', 'import', 'export',
  'const', 'async', 'await', 'yield', 'static', 'public', 'private', 'protected', 'void', 'undefined',
  'size', 'length', 'count', 'total', 'first', 'last', 'next', 'prev', 'time', 'date',
  'values', 'entry', 'entries', 'field', 'fields', 'schema', 'source', 'target', 'format', 'mode',
  'level', 'debug', 'logger', 'build', 'setup', 'update', 'create', 'delete', 'remove', 'insert',
  'find', 'filter', 'reduce', 'sort', 'merge', 'parse', 'render', 'style', 'styles', 'theme',
  'color', 'width', 'height', 'left', 'right', 'bottom', 'host', 'port', 'uuid', 'token',
  'tokens', 'hash', 'version', 'environment', 'application', 'service', 'route', 'routes', 'query', 'check',
  'valid', 'validate', 'example', 'examples', 'sample', 'demo', 'todo', 'note', 'notes', 'readme',
  'usage', 'overview', 'description', 'summary', 'section', 'intro', 'introduction', 'getting', 'started', 'installation',
  'install', 'license', 'contributing', 'changelog', 'that', 'with', 'from', 'then', 'else', 'when',
]);
