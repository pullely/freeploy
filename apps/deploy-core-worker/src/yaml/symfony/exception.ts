// Derived from symfony/yaml@v8.1.11:Exception/ParseException.php and ParserState.php (MIT), modified.
//
// The raw message, the line and the snippet are kept apart and the message is put together as updateRepr() does it:
// the final dot moved after " at line N" and ' (near "…")'. The snippet is a byte string (php-string.ts); the message is
// UTF-8 text. No file name: Coolify parses strings.
import { fromBytes } from "./php-string.js";

export class SymfonyYamlParseException extends Error {
  readonly rawMessage: string;
  parsedLine: number;
  /** A byte string, or null. */
  snippet: string | null;

  constructor(rawMessage: string, parsedLine = -1, snippet: string | null = null) {
    super("");
    this.name = "SymfonyYamlParseException";
    this.rawMessage = rawMessage;
    this.parsedLine = parsedLine;
    this.snippet = snippet;
    this.updateRepr();
  }

  setParsedLine(line: number): void {
    this.parsedLine = line;
    this.updateRepr();
  }

  setSnippet(snippet: string): void {
    this.snippet = snippet;
    this.updateRepr();
  }

  private updateRepr(): void {
    let message = this.rawMessage;
    let dot = false;
    if (message.endsWith(".")) {
      message = message.slice(0, -1);
      dot = true;
    }
    if (this.parsedLine >= 0) message += ` at line ${this.parsedLine}`;
    // if ($this->snippet): "0" is false in PHP.
    if (this.snippet !== null && this.snippet !== "" && this.snippet !== "0") message += ` (near "${this.snippet}")`;
    if (dot) message += ".";
    this.message = fromBytes(message);
  }
}

/** ParserState: the nesting depth and the count of collection aliases of one parse (Yaml::parse()'s defaults). */
export class ParserState {
  maxNestingLevel = 128;
  currentNestingLevel = 0;
  maxAliasesForCollections = 128;
  collectionAliasCount = 0;

  enterNestingLevel(line: number, snippet: string | null): void {
    if (++this.currentNestingLevel > this.maxNestingLevel) {
      --this.currentNestingLevel;
      throw new SymfonyYamlParseException(`Maximum nesting depth of ${this.maxNestingLevel} exceeded.`, line, snippet);
    }
  }

  leaveNestingLevel(): void {
    if (this.currentNestingLevel > 0) --this.currentNestingLevel;
  }

  /** countAlias(): aliases are enabled (no PARSE_EXCEPTION_ON_ALIAS); only collections count. */
  countAlias(refValue: unknown, line: number, snippet: string | null, isCollection: (v: unknown) => boolean): void {
    if (!isCollection(refValue)) return;
    if (++this.collectionAliasCount > this.maxAliasesForCollections) {
      throw new SymfonyYamlParseException(`Maximum number of collection aliases (${this.maxAliasesForCollections}) exceeded. This limit can be increased via the Parser constructor.`, line, snippet);
    }
  }
}
