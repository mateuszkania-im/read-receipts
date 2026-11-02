// What the read metrics mean (spec 6.3), carried in every report and shown in every view.

export const SPEC_6_3_URL = 'https://github.com/mateuszkania-im/read-receipts/blob/main/docs/superpowers/specs/2026-11-01-agent-ledger-design.md#63-reads-and-unreferenced-reads';

/** The rules, one per line, as the terminal footer and the HTML method section list them. */
export const REFERENCE_RULES = [
  'an edit of the file;',
  'its full path, a path suffix (the end of its path) no other file of the session shares, or its basename when that is 6 or more characters with a dot;',
  'an identifier declared in it;',
  'for a test file, one of its test titles, or an edit of the module under test.',
];

export const DEFINITIONS = {
  unreferenced:
    `A read is unreferenced when nothing the agent did after it refers back to it. A later edit, command or text refers back to it through ${REFERENCE_RULES.join(' ')} ` +
    `It includes reads used to rule something out, so it does not mean the read was useless. Full rules: spec 6.3, ${SPEC_6_3_URL}`,
  referenced: 'A read is referenced when a later edit, path mention, identifier, test title or edit of the module under test refers back to it. It includes files named only to dismiss them.',
};
