const color = (code, text, enabled) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
const safeText = value => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

function wrapLine(line, width) {
  if (!line) return [''];
  const words = line.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      if (word.length <= width) current = word;
      else {
        for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
      }
    } else if (current.length + word.length + 1 <= width) current += ` ${word}`;
    else {
      lines.push(current);
      if (word.length <= width) current = word;
      else {
        for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
        current = '';
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function fit(text, width) {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

export class TerminalUI {
  constructor({ readline, stdout, provider, model, root }) {
    Object.assign(this, { readline, stdout });
    this.provider = safeText(provider);
    this.model = safeText(model);
    this.root = safeText(root);
    this.messages = [];
    this.status = 'Ready';
    this.started = false;
    this.colorEnabled = process.env.NO_COLOR === undefined;
  }

  start() {
    this.stdout.write('\x1b[?1049h');
    this.started = true;
    this.render();
  }

  addMessage(role, text) {
    this.messages.push({ role, text: safeText(text) });
    this.render();
  }

  clearMessages() {
    this.messages = [];
    this.render();
  }

  setStatus(status) {
    this.status = status;
    this.render();
  }

  async question(prompt = 'op> ') {
    this.render();
    this.stdout.write('\x1b[?25h');
    try {
      return await this.readline.question(prompt);
    } finally {
      this.render();
    }
  }

  render() {
    if (!this.started) return;
    const width = Math.max(20, this.stdout.columns || 80);
    const height = Math.max(8, this.stdout.rows || 24);
    const chatRows = Math.max(1, height - 7);
    const divider = color('90', '─'.repeat(width), this.colorEnabled);
    const transcript = [];

    for (const message of this.messages) {
      const labelColor = message.role === 'you' ? '36' : message.role === 'approval' ? '33' : '32';
      transcript.push(color(`1;${labelColor}`, message.role.toUpperCase(), this.colorEnabled));
      for (const paragraph of message.text.split('\n')) {
        for (const line of wrapLine(paragraph, Math.max(10, width - 2))) transcript.push(`  ${line}`);
      }
    }

    const chat = transcript.slice(-chatRows);
    while (chat.length < chatRows) chat.unshift('');
    const title = color('1;36', 'op-agent', this.colorEnabled);
    const project = fit(`${this.provider}/${this.model} · ${this.root}`, width);
    const lines = [
      `${title}  ${color('90', 'terminal coding assistant', this.colorEnabled)}`,
      project,
      divider,
      ...chat,
      divider,
      fit(this.status, width),
      '',
      color('90', '/help commands  ·  /clear reset chat  ·  /exit quit', this.colorEnabled),
    ];
    this.stdout.write(`\x1b[?25l\x1b[2J\x1b[H${lines.join('\n')}\x1b[${height - 1};1H`);
  }

  close() {
    if (!this.started) return;
    this.started = false;
    this.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}
