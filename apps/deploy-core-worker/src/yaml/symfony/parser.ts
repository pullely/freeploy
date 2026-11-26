// Derived from symfony/yaml@v8.1.11:Parser.php (MIT), modified.
//
// Symfony's block reader, as Yaml::parse($yaml) runs it with no flags, method by method: doParse(), parseBlock(),
// getNextEmbedBlock(), parseValue(), parseBlockScalar(), cleanup(), the line moves and the inline lexers. What is left out:
//
// - the flags (Coolify passes none): no custom tags (a tag is the "Tags support is not enabled" error, as Symfony's), no
//   objects, constants, DateTime values or object maps;
// - indexLines() and the blocks "read in place" (createBlock(), readBlock(), useBlock(), getBlockText()): Symfony 8 only
//   takes that path for a document of more than 1024 lines, as a faster way to the same result, so every nested block is
//   copied here, as Symfony does for a shorter document;
// - skippedLineNumbers: nothing in 8.1 adds to it.
//
// Strings are byte strings (php-string.ts) from cleanup() on; parse() takes and returns UTF-8 text.
import { PhpArray, PhpFloat, isNumeric, type PhpKey, type PhpValue } from "../../compose/php.js";
import { TaggedValue } from "../../compose/yaml.js";
import { ParserState, SymfonyYamlParseException } from "./exception.js";
import { REGEX_QUOTED_STRING, arrayUnion, evaluateBinaryScalar, inlineParse, inlineState, parseScalar, phpTruthyString, type References } from "./inline.js";
import { pregMatch, pregReplace } from "./pcre.js";
import { ltrim, rtrim, strcspn, strspn, substr, substrCount, trim } from "./php-string.js";

const TAG_PATTERN = "(?P<tag>![\\w!.\\/:-]+)";
const BLOCK_SCALAR_HEADER_PATTERN = "(?P<separator>\\||>)(?P<modifiers>\\+|\\-|\\d+|\\+\\d+|\\-\\d+|\\d+\\+|\\d+\\-)?(?P<comments>[ \\t]+#.*)?";
const REFERENCE_PATTERN = "^&(?P<ref>(?>[^ ]+))(?> *)(?P<value>.*)";
const COMMENT = "(?<![ \\t])(?>[ \\t]+)#";

export type YamlValue = PhpValue | TaggedValue;

const isCollection = (v: unknown): boolean => v instanceof PhpArray || (v instanceof TaggedValue && v.value instanceof PhpArray);
/** isset($array[$key]) */
const isSet = (a: PhpArray, key: PhpKey): boolean => a.has(key) && a.get(key) !== null;
const asKey = (k: PhpValue): PhpKey => (typeof k === "bigint" ? k.toString() : (k as PhpKey));
/** (string) of a scalar, for a snippet. */
const scalarSnippet = (v: YamlValue | undefined): string | null => {
  if (v === null || v === undefined || v instanceof PhpArray || v instanceof TaggedValue) return null;
  if (v === true) return "1";
  if (v === false) return "";
  if (v instanceof PhpFloat) return String(v.value);
  return String(v);
};
const lastValue = (a: PhpArray): YamlValue => {
  const values = a.values();
  return values.length ? (values[values.length - 1] as YamlValue) : (false as unknown as YamlValue);
};

class Parser {
  offset = 0;
  numberOfParsedLines = 0;
  totalNumberOfLines: number | null = null;
  lines: string[] = [];
  currentLineNb = -1;
  currentLine = "";
  refs: References = new Map();
  refsBeingParsed: string[] = [];
  state: ParserState;

  constructor(state: ParserState) {
    this.state = state;
  }

  doParse(input: string): YamlValue {
    this.currentLineNb = -1;
    this.currentLine = "";
    const marker = { hasContentOnStartMarkerLine: false };
    const value = this.cleanup(input, marker);
    const hasContentOnStartMarkerLine = marker.hasContentOnStartMarkerLine;
    this.lines = value.split("\n");
    this.numberOfParsedLines = this.lines.length;
    this.totalNumberOfLines ??= this.numberOfParsedLines;

    if (!this.moveToNextLine()) return null;
    const data = new PhpArray();
    let context: "sequence" | "mapping" | null = null;
    let allowOverwrite = false;
    while (this.isCurrentLineEmpty()) {
      if (!this.moveToNextLine()) return null;
    }
    // Resolves the tag and returns if end of the document: without PARSE_CUSTOM_TAGS getLineTag() throws for a tag, or gives none.
    this.getLineTag(this.currentLine, false);

    do {
      if (this.isCurrentLineEmpty()) continue;
      // tab?
      if (this.currentLine[0] === "\t") throw new SymfonyYamlParseException("A YAML file cannot contain tabs as indentation.", this.getRealCurrentLineNb() + 1, this.currentLine);
      inlineState.parsedLineNumber = this.getRealCurrentLineNb();
      let isRef: string | false = false;
      let mergeNode = false;
      let values = this.currentLine[0] === "-" ? pregMatch("^\\-((?P<leadspaces>\\s+)(?P<value>.+))?$", rtrim(this.currentLine)) : null;
      if (values) {
        if (context === "mapping") throw new SymfonyYamlParseException("You cannot define a sequence item when in a mapping.", this.getRealCurrentLineNb() + 1, this.currentLine);
        context = "sequence";
        if (hasContentOnStartMarkerLine && this.currentLineNb === 0) throw new SymfonyYamlParseException("A block collection cannot start on the line of the document start marker (---).", this.getRealCurrentLineNb() + 1, this.currentLine);
        let v = values.groups.value;
        const leadspaces = values.groups.leadspaces;
        if (v !== undefined && v[0] === "!") v = this.moveAnchorBeforeTag(v);
        if (v !== undefined && v[0] === "&") {
          const matches = pregMatch(REFERENCE_PATTERN, v);
          if (matches) {
            isRef = matches.groups.ref!;
            this.refsBeingParsed.push(isRef);
            v = matches.groups.value ?? "";
          }
        }
        if (v !== undefined && v.length > 1 && v[0] === "?" && v[1] === " ") throw new SymfonyYamlParseException("Complex mappings are not supported.", this.getRealCurrentLineNb() + 1, this.currentLine);
        if (v !== undefined && ltrim(v, " ").startsWith("-")) {
          // Inline first child
          const currentLineNumber = this.getRealCurrentLineNb();
          const sequenceIndentation = (leadspaces ?? "").length + 1;
          let sequenceYaml = substr(this.currentLine, sequenceIndentation);
          const embedBlock = this.getNextEmbedBlock(sequenceIndentation, true);
          // keep trailing empty lines, they can be part of a block scalar
          if (currentLineNumber !== this.getRealCurrentLineNb()) sequenceYaml = `${sequenceYaml}\n${embedBlock}`;
          data.push(this.parseBlock(currentLineNumber, sequenceYaml) as PhpValue);
        } else if (v === undefined || trim(v, " ") === "" || ltrim(v, " ").startsWith("#")) {
          data.push(this.parseBlock(this.getRealCurrentLineNb() + 1, this.getNextEmbedBlock(null, true)) as PhpValue);
        } else if (this.getLineTag(ltrim(v, " "), true) !== null) {
          // getLineTag() throws for a tag Symfony would take here; without PARSE_CUSTOM_TAGS it never gives one
        } else if (pregMatch(`^${TAG_PATTERN}[ \\t]+${BLOCK_SCALAR_HEADER_PATTERN}$`, v)) {
          data.push(this.parseValue(v, context) as PhpValue);
        } else if (leadspaces !== undefined && (v[0] === "!" || pregMatch(`^(?P<key>${REGEX_QUOTED_STRING}|[^ '"\\{\\[](?>(?:(?>[^ :]+)|(?> +)(?!:(?:\\s|$))|:(?!\\s|$))*))(?> *)\\:(?:(?>\\s+)(?P<value>(?>(?:(?>\\s*)\\S)+)))?(?>\\s*)$`, this.trimTag(v)))) {
          const currentLineNumber = this.getRealCurrentLineNb();
          let block = v;
          if (this.isNextLineIndented() || this.isNextLineInBlockScalar(block)) block = `${block}\n${this.getNextEmbedBlock(this.getCurrentLineIndentation() + leadspaces.length + 1)}`;
          data.push(this.parseBlock(currentLineNumber, block) as PhpValue);
        } else {
          data.push(this.parseValue(v, context) as PhpValue);
        }
        if (isRef !== false) {
          this.refs.set(isRef, lastValue(data) as PhpValue);
          this.refsBeingParsed.pop();
        }
        continue;
      }
      values = pregMatch(
        `^(?P<key>(?:!(?>[^\\s]+)(?>\\s+))?(?:${REGEX_QUOTED_STRING}|[^ '"\\[\\{!](?>(?:(?>[^ :]+)|(?> +)(?!:(?:[ \\t]|$))|:(?![ \\t]|$))*))|!(?>[^\\s]+)(?= +\\:))(?> *)\\:(?:(?>(?: |\\t)+)(?P<value>.+))?$`,
        rtrim(this.currentLine),
      );
      if (values && (!values.groups.key!.includes(" #") || values.groups.key![0] === '"' || values.groups.key![0] === "'")) {
        if (context === "sequence") throw new SymfonyYamlParseException("You cannot define a mapping item when in a sequence.", this.currentLineNb + 1, this.currentLine);
        context = "mapping";
        if (hasContentOnStartMarkerLine && this.currentLineNb === 0) throw new SymfonyYamlParseException("A block collection cannot start on the line of the document start marker (---).", this.getRealCurrentLineNb() + 1, this.currentLine);
        let v = values.groups.value;
        const rawKey = values.groups.key!;
        if (v !== undefined && v[0] === "!") v = this.moveAnchorBeforeTag(v);
        let key: PhpValue;
        try {
          key = parseScalar(rawKey, null, { at: 0 }, true, this.refs, { quoted: null }, this.state);
        } catch (e) {
          if (e instanceof SymfonyYamlParseException) {
            e.setParsedLine(this.getRealCurrentLineNb() + 1);
            e.setSnippet(this.currentLine);
          }
          throw e;
        }
        if (typeof key !== "string" && !(typeof key === "number" && Number.isInteger(key)) && typeof key !== "bigint") {
          throw new SymfonyYamlParseException(`${isNumeric(key) ? "Numeric" : "Non-string"} keys are not supported. Quote your evaluable mapping keys instead.`, this.getRealCurrentLineNb() + 1, this.currentLine);
        }
        const k = asKey(key);
        // Only a plain (unquoted) "<<" key is a merge key
        const isMergeKey = rtrim(rawKey) === "<<";
        let refMatches: ReturnType<typeof pregMatch> = null;
        if (isMergeKey && (v === undefined || v[0] !== "&" || !(refMatches = pregMatch("^&(?P<ref>[^ ]+)", v)))) {
          mergeNode = true;
          allowOverwrite = true;
          if (v !== undefined && v[0] === "*") {
            let refName = substr(rtrim(v), 1);
            // remove comments
            const m = pregMatch(COMMENT, refName);
            if (m) refName = substr(refName, 0, m.index);
            if (!this.refs.has(refName)) {
              const pos = this.refsBeingParsed.indexOf(refName);
              if (pos !== -1) throw new SymfonyYamlParseException(`Circular reference [${[...this.refsBeingParsed.slice(pos), refName].join(", ")}] detected for reference "${refName}".`, this.currentLineNb + 1, this.currentLine);
              throw new SymfonyYamlParseException(`Reference "${refName}" does not exist.`, this.getRealCurrentLineNb() + 1, this.currentLine);
            }
            const refValue = this.refs.get(refName) as YamlValue;
            this.state.countAlias(refValue, this.getRealCurrentLineNb() + 1, this.currentLine, isCollection);
            if (!(refValue instanceof PhpArray)) throw new SymfonyYamlParseException("YAML merge keys used with a scalar value instead of an array.", this.getRealCurrentLineNb() + 1, this.currentLine);
            arrayUnion(data, refValue);
          } else {
            const currentLineNumber = this.getRealCurrentLineNb();
            const block = v !== undefined && v !== "" ? v : this.getNextEmbedBlock();
            const parsed = this.parseBlock(currentLineNumber + 1, block);
            if (!(parsed instanceof PhpArray)) throw new SymfonyYamlParseException("YAML merge keys used with a scalar value instead of an array.", this.getRealCurrentLineNb() + 1, this.currentLine);
            if (pregMatch("^(?>(?:(?>[ \\t]*)(?:#(?>.*))?\\n)*)(?>[ \\t]*)(?:\\[|-(?:\\s|$))", block)) {
              // a sequence of mappings, merged in turn
              for (const parsedItem of parsed.values() as YamlValue[]) {
                if (!(parsedItem instanceof PhpArray)) throw new SymfonyYamlParseException("Merge items must be arrays.", this.getRealCurrentLineNb() + 1, scalarSnippet(parsedItem));
                arrayUnion(data, parsedItem);
              }
            } else {
              arrayUnion(data, parsed);
            }
          }
        } else if (!isMergeKey && v !== undefined && v[0] === "&") {
          const matches = pregMatch(REFERENCE_PATTERN, v);
          if (matches) {
            isRef = matches.groups.ref!;
            this.refsBeingParsed.push(isRef);
            v = matches.groups.value ?? "";
          }
        }

        if (mergeNode) {
          // Merge keys
        } else if (v === undefined || v === "" || v.startsWith("#") || this.getLineTag(v, true) !== null || isMergeKey) {
          // hash: if the next line is less indented or equal, the value is null
          if (!this.isNextLineIndented() && !this.isNextLineUnIndentedCollection()) {
            if (allowOverwrite || !isSet(data, k)) {
              if (!allowOverwrite && data.has(k)) throw new SymfonyYamlParseException(`Duplicate key "${String(k)}" detected.`, this.getRealCurrentLineNb() + 1, this.currentLine);
              data.set(k, null);
            } else {
              throw new SymfonyYamlParseException(`Duplicate key "${String(k)}" detected.`, this.getRealCurrentLineNb() + 1, this.currentLine);
            }
          } else {
            const realCurrentLineNbKey = this.getRealCurrentLineNb();
            const value = this.parseBlock(this.getRealCurrentLineNb() + 1, this.getNextEmbedBlock());
            if (isMergeKey) {
              this.refs.set(refMatches!.groups.ref!, value as PhpValue);
              if (value instanceof PhpArray) arrayUnion(data, value);
              else throw new SymfonyYamlParseException("Unsupported operand types: array + " + phpType(value), -1, null);
            } else if (allowOverwrite || !isSet(data, k)) {
              if (!allowOverwrite && data.has(k)) throw new SymfonyYamlParseException(`Duplicate key "${String(k)}" detected.`, this.getRealCurrentLineNb() + 1, this.currentLine);
              data.set(k, value as PhpValue);
            } else {
              throw new SymfonyYamlParseException(`Duplicate key "${String(k)}" detected.`, realCurrentLineNbKey + 1, this.currentLine);
            }
          }
        } else {
          const value = this.parseValue(rtrim(v), context);
          if (allowOverwrite || !isSet(data, k)) {
            if (!allowOverwrite && data.has(k)) throw new SymfonyYamlParseException(`Duplicate key "${String(k)}" detected.`, this.getRealCurrentLineNb() + 1, this.currentLine);
            data.set(k, value as PhpValue);
          } else {
            throw new SymfonyYamlParseException(`Duplicate key "${String(k)}" detected.`, this.getRealCurrentLineNb() + 1, this.currentLine);
          }
        }
        if (isRef !== false) {
          this.refs.set(isRef, data.get(k) as PhpValue);
          this.refsBeingParsed.pop();
        }
        continue;
      }
      const first = this.currentLine[0];
      if (first === '"' || first === "'") {
        if (context !== null) throw new SymfonyYamlParseException("Unable to parse.", this.getRealCurrentLineNb() + 1, this.currentLine);
        try {
          return inlineParse(this.lexInlineQuotedString({ at: 0 }), this.refs, this.state);
        } catch (e) {
          throw this.located(e);
        }
      }
      if (first === "{" || first === "[") {
        if (context !== null) throw new SymfonyYamlParseException("Unable to parse.", this.getRealCurrentLineNb() + 1, this.currentLine);
        try {
          const parsed = inlineParse(this.lexInlineStructure({ at: 0 }, first === "{" ? "}" : "]"), this.refs, this.state);
          while (this.moveToNextLine()) {
            if (!this.isCurrentLineEmpty()) throw new SymfonyYamlParseException("Unable to parse.", this.getRealCurrentLineNb() + 1, this.currentLine);
          }
          return parsed;
        } catch (e) {
          throw this.located(e);
        }
      }
      if (this.currentLine.length > 1 && this.currentLine[0] === "?" && this.currentLine[1] === " ") throw new SymfonyYamlParseException("Complex mappings are not supported.", this.getRealCurrentLineNb() + 1, this.currentLine);
      // 1-liner optionally followed by newline(s)
      if (this.lines[0] === trim(value)) {
        try {
          return inlineParse(this.lines[0]!, this.refs, this.state);
        } catch (e) {
          throw this.located(e);
        }
      }
      // try to parse the value as a multi-line string as a last resort
      if (this.currentLineNb === 0) {
        let previousLineWasNewline = false;
        let previousLineWasTerminatedWithBackslash = false;
        let text = "";
        for (const line of this.lines) {
          const trimmedLine = trim(line);
          if (trimmedLine[0] === "#") continue;
          // If the indentation is not consistent at offset 0, it is to be considered as a ParseError
          if (this.offset === 0 && line[0] === " ") throw new SymfonyYamlParseException("Unable to parse.", this.getRealCurrentLineNb() + 1, this.currentLine);
          if (line.includes(": ")) throw new SymfonyYamlParseException("Mapping values are not allowed in multi-line blocks.", this.getRealCurrentLineNb() + 1, this.currentLine);
          if (trimmedLine === "") text += "\n";
          else if (!previousLineWasNewline && !previousLineWasTerminatedWithBackslash) text += " ";
          if (trimmedLine !== "" && line.endsWith("\\")) text += ltrim(line.slice(0, -1));
          else if (trimmedLine !== "") text += trimmedLine;
          if (trimmedLine === "") {
            previousLineWasNewline = true;
            previousLineWasTerminatedWithBackslash = false;
          } else if (line.endsWith("\\")) {
            previousLineWasNewline = false;
            previousLineWasTerminatedWithBackslash = true;
          } else {
            previousLineWasNewline = false;
            previousLineWasTerminatedWithBackslash = false;
          }
        }
        try {
          return inlineParse(trim(text), this.refs, this.state);
        } catch (e) {
          if (!(e instanceof SymfonyYamlParseException)) throw e;
          // fall-through to the ParseException thrown below
        }
      }
      throw new SymfonyYamlParseException("Unable to parse.", this.getRealCurrentLineNb() + 1, this.currentLine);
    } while (this.moveToNextLine());

    return data.size > 0 ? data : null;
  }

  /** catch (ParseException $e) { $e->setParsedLine(…); $e->setSnippet(…); throw $e; } */
  private located(e: unknown): unknown {
    if (e instanceof SymfonyYamlParseException) {
      e.setParsedLine(this.getRealCurrentLineNb() + 1);
      e.setSnippet(this.currentLine);
    }
    return e;
  }

  parseBlock(offset: number, yaml: string): YamlValue {
    const parser = new Parser(this.state);
    parser.offset = offset;
    parser.totalNumberOfLines = this.totalNumberOfLines;
    parser.refs = this.refs;
    parser.refsBeingParsed = [...this.refsBeingParsed];
    this.state.enterNestingLevel(offset + 1, this.currentLine);
    try {
      return parser.doParse(yaml);
    } finally {
      this.state.leaveNestingLevel();
    }
  }

  getRealCurrentLineNb(): number {
    return this.currentLineNb + this.offset;
  }

  private getCurrentLineIndentation(): number {
    if (this.currentLine[0] !== " ") return 0;
    return this.currentLine.length - ltrim(this.currentLine, " ").length;
  }

  /** getNextEmbedBlock() */
  private getNextEmbedBlock(indentation: number | null = null, inSequence = false): string {
    const oldLineIndentation = this.getCurrentLineIndentation();
    if (!this.moveToNextLine()) return "";
    let nextContentLine: string | null = null;
    let newIndent: number | null;
    if (indentation === null) {
      newIndent = null;
      let movements = 0;
      let EOF: boolean;
      do {
        EOF = false;
        // empty and comment-like lines do not influence the indentation depth
        if (this.isCurrentLineEmpty() || this.isCurrentLineComment()) {
          EOF = !this.moveToNextLine();
          if (!EOF) ++movements;
        } else {
          newIndent = this.getCurrentLineIndentation();
          nextContentLine = substr(this.currentLine, newIndent);
        }
      } while (!EOF && newIndent === null);
      for (let i = 0; i < movements; ++i) this.moveToPreviousLine();
      const unindentedEmbedBlock = this.isStringUnIndentedCollectionItem();
      if (!this.isCurrentLineEmpty() && newIndent === 0 && !unindentedEmbedBlock) throw new SymfonyYamlParseException("Indentation problem.", this.getRealCurrentLineNb() + 1, this.currentLine);
    } else {
      newIndent = indentation;
    }
    const data: string[] = [];
    // PHP compares an int with null as with 0.
    const indent0 = newIndent ?? 0;
    if (this.getCurrentLineIndentation() >= indent0) data.push(substr(this.currentLine, indent0));
    else if (this.isCurrentLineEmpty() || this.isCurrentLineComment()) data.push(this.currentLine);
    else {
      this.moveToPreviousLine();
      return "";
    }
    nextContentLine ??= data[0]!;
    if (inSequence && oldLineIndentation === newIndent && nextContentLine[0] === "-") {
      // the previous line contained a dash but no item content, this line is a sequence item with the same indentation
      this.moveToPreviousLine();
      return "";
    }
    let isItUnindentedCollection = this.isStringUnIndentedCollectionItem();
    let isItComment = this.isCurrentLineComment();
    while (this.moveToNextLine()) {
      if (isItComment && !isItUnindentedCollection) {
        isItUnindentedCollection = this.isStringUnIndentedCollectionItem();
        isItComment = this.isCurrentLineComment();
      }
      const indent = this.getCurrentLineIndentation();
      if (isItUnindentedCollection && !this.isCurrentLineEmpty() && !this.isStringUnIndentedCollectionItem() && newIndent === indent) {
        this.moveToPreviousLine();
        break;
      }
      if (this.isCurrentLineBlank()) {
        data.push(substr(this.currentLine, indent0));
        continue;
      }
      if (indent >= indent0) data.push(substr(this.currentLine, indent0));
      else if (this.isCurrentLineComment()) data.push(this.currentLine);
      else if (indent === 0) {
        this.moveToPreviousLine();
        break;
      } else {
        throw new SymfonyYamlParseException("Indentation problem.", this.getRealCurrentLineNb() + 1, this.currentLine);
      }
    }
    return data.join("\n");
  }

  private hasMoreLines(): boolean {
    return this.numberOfParsedLines - 1 > this.currentLineNb;
  }

  private moveToNextLine(): boolean {
    if (this.currentLineNb >= this.numberOfParsedLines - 1) return false;
    this.currentLine = this.lines[++this.currentLineNb]!;
    return true;
  }

  private moveToPreviousLine(): boolean {
    if (this.currentLineNb < 1) return false;
    this.currentLine = this.lines[--this.currentLineNb]!;
    return true;
  }

  /** parseValue() */
  private parseValue(input: string, context: "sequence" | "mapping"): YamlValue {
    let value = input;
    if (value.startsWith("*")) {
      value = value.slice(1);
      // remove comments
      const m = pregMatch(COMMENT, value);
      if (m) value = substr(value, 0, m.index);
      if (!this.refs.has(value)) {
        const pos = this.refsBeingParsed.indexOf(value);
        if (pos !== -1) throw new SymfonyYamlParseException(`Circular reference [${[...this.refsBeingParsed.slice(pos), value].join(", ")}] detected for reference "${value}".`, this.currentLineNb + 1, this.currentLine);
        throw new SymfonyYamlParseException(`Reference "${value}" does not exist.`, this.currentLineNb + 1, this.currentLine);
      }
      this.state.countAlias(this.refs.get(value), this.getRealCurrentLineNb() + 1, this.currentLine, isCollection);
      return this.refs.get(value)!;
    }
    if (["!", "|", ">"].includes(value[0] ?? "")) {
      const matches = pregMatch(`^(?:${TAG_PATTERN}[ \\t]+)?${BLOCK_SCALAR_HEADER_PATTERN}$`, value);
      if (matches) {
        const modifiers = matches.groups.modifiers ?? "";
        const data = this.parseBlockScalar(matches.groups.separator!, modifiers.replace(/[0-9]+/g, ""), Math.abs(phpIntCast(modifiers)));
        const tag = matches.groups.tag ?? "";
        if (tag !== "" && tag !== "!") {
          if (tag === "!!binary") return evaluateBinaryScalar(data, this.refs, this.state);
          if (tag === "!!str") return data;
          if (tag === "!!float") return new PhpFloat(phpFloatCast(data));
          return new TaggedValue(tag.slice(1), data);
        }
        return data;
      }
    }
    try {
      if (value !== "" && (value[0] === "{" || value[0] === "[")) {
        const cursor = { at: rtrim(this.currentLine).length - rtrim(value).length };
        return inlineParse(this.lexInlineStructure(cursor, value[0] === "{" ? "}" : "]"), this.refs, this.state);
      }
      if (value[0] === '"' || value[0] === "'") {
        const cursor = { at: rtrim(this.currentLine).length - rtrim(value).length };
        const parsedValue = inlineParse(this.lexInlineQuotedString(cursor), this.refs, this.state);
        if (cursor.at < this.currentLine.length) {
          const rest = substr(this.currentLine, cursor.at);
          if (phpTruthyString(pregReplace("\\s*(#.*)?$", "A", rest, () => "", 1).result)) throw new SymfonyYamlParseException(`Unexpected characters near "${rest}".`);
        }
        return parsedValue;
      }
      const lines: string[] = [];
      while (this.moveToNextLine()) {
        // unquoted strings end before the first unindented line
        if (this.getCurrentLineIndentation() === 0) {
          this.moveToPreviousLine();
          break;
        }
        if (this.isCurrentLineComment()) break;
        if (context === "mapping" && this.currentLine.includes(": ") && !this.isCurrentLineComment()) throw new SymfonyYamlParseException("A colon cannot be used in an unquoted mapping value.", this.getRealCurrentLineNb() + 1, this.currentLine);
        lines.push(trim(this.currentLine));
      }
      let previousLineBlank = false;
      for (const line of lines) {
        if (line === "") {
          value += "\n";
          previousLineBlank = true;
        } else if (previousLineBlank) {
          value += line;
          previousLineBlank = false;
        } else {
          value += ` ${line}`;
          previousLineBlank = false;
        }
      }
      inlineState.parsedLineNumber = this.getRealCurrentLineNb();
      const parsedValue = inlineParse(value, this.refs, this.state);
      if (context === "mapping" && typeof parsedValue === "string" && !['"', "'", "[", "{", "!"].includes(value[0]!) && parsedValue.includes(": ")) {
        throw new SymfonyYamlParseException("A colon cannot be used in an unquoted mapping value.", this.getRealCurrentLineNb() + 1, value);
      }
      return parsedValue;
    } catch (e) {
      throw this.located(e);
    }
  }

  /** parseBlockScalar() */
  private parseBlockScalar(style: string, chomping = "", indentation0 = 0): string {
    let indentation = indentation0;
    let notEOF = this.moveToNextLine();
    if (!notEOF) return "";
    let isCurrentLineBlank = this.isCurrentLineBlank();
    const blockLines: string[] = [];
    // leading blank lines are consumed before determining indentation
    while (notEOF && isCurrentLineBlank && (!indentation || this.currentLine.length <= indentation)) {
      if ((notEOF = this.moveToNextLine())) {
        blockLines.push("");
        isCurrentLineBlank = this.isCurrentLineBlank();
      }
    }
    // determine indentation if not specified
    if (indentation === 0) {
      for (let i = 0; i < this.currentLine.length && this.currentLine[i] === " "; ++i) ++indentation;
    }
    if (!notEOF || !indentation || strspn(this.currentLine, " ") < indentation) {
      if (notEOF) this.moveToPreviousLine();
      else if (!this.isCurrentLineLastLineInDocument()) blockLines.push("");
      // without content, the line breaks of the empty lines are only kept with the "+" chomping indicator
      return chomping === "+" ? "\n".repeat(blockLines.length) : "";
    }
    const prefix = " ".repeat(indentation);
    while (notEOF && (isCurrentLineBlank || this.currentLine.startsWith(prefix))) {
      if (isCurrentLineBlank && this.currentLine.length > indentation) blockLines.push(substr(this.currentLine, indentation));
      else if (isCurrentLineBlank) blockLines.push("");
      else blockLines.push(this.currentLine.slice(indentation));
      if ((notEOF = this.moveToNextLine())) isCurrentLineBlank = this.isCurrentLineBlank();
    }
    if (notEOF) {
      blockLines.push("");
      this.moveToPreviousLine();
    } else if (!this.isCurrentLineLastLineInDocument()) {
      blockLines.push("");
    }
    let text: string;
    if (style === ">") {
      // folded style
      text = "";
      let previousLineIndented: boolean | null = null;
      let previousLineBlank = false;
      for (let i = 0; i < blockLines.length; ++i) {
        const line = blockLines[i]!;
        if (line === "") {
          text += "\n";
          previousLineBlank = true;
        } else if (line[0] === " " || line[0] === "\t") {
          text += (previousLineIndented === null ? "" : "\n") + line;
          previousLineIndented = true;
          previousLineBlank = false;
        } else if (previousLineIndented) {
          text += `\n${line}`;
          previousLineIndented = false;
          previousLineBlank = false;
        } else if (previousLineBlank || i === 0) {
          text += line;
          previousLineIndented = false;
          previousLineBlank = false;
        } else {
          text += ` ${line}`;
          previousLineIndented = false;
          previousLineBlank = false;
        }
      }
    } else {
      text = blockLines.join("\n");
    }
    // deal with trailing newlines
    if (chomping === "" && text.endsWith("\n")) text = `${rtrim(text, "\n")}\n`;
    else if (chomping === "-") text = rtrim(text, "\n");
    return text;
  }

  private isNextLineIndented(): boolean {
    const currentIndentation = this.getCurrentLineIndentation();
    let movements = 0;
    let EOF: boolean;
    do {
      EOF = !this.moveToNextLine();
      if (!EOF) ++movements;
    } while (!EOF && (this.isCurrentLineEmpty() || this.isCurrentLineComment()));
    const ret = !EOF && this.getCurrentLineIndentation() > currentIndentation;
    for (let i = 0; i < movements; ++i) this.moveToPreviousLine();
    return ret;
  }

  private isCurrentLineEmpty(): boolean {
    return this.isCurrentLineBlank() || this.isCurrentLineComment();
  }

  private isCurrentLineBlank(): boolean {
    return this.currentLine === "" || trim(this.currentLine, " ") === "";
  }

  private isCurrentLineComment(): boolean {
    const l = this.currentLine !== "" && this.currentLine[0] === " " ? ltrim(this.currentLine, " ") : this.currentLine;
    return l !== "" && l[0] === "#";
  }

  private isCurrentLineLastLineInDocument(): boolean {
    return this.offset + this.currentLineNb >= (this.totalNumberOfLines ?? 0) - 1;
  }

  /** cleanup() */
  private cleanup(input: string, marker: { hasContentOnStartMarkerLine: boolean }): string {
    marker.hasContentOnStartMarkerLine = false;
    let value = input.replace(/\r\n|\r/g, "\n");
    // remove the byte order mark (BOM) at the start of the stream, not at the start of a nested block
    if (this.totalNumberOfLines === null && value.startsWith("\xef\xbb\xbf")) value = value.slice(3);
    // remove the YAML header, and the comments and empty lines before the content
    value = this.removeLeadingLines("^(?>(?:(?>[ \\t]*)(?>(?:#(?>[^\\n]*))?)\\n)*)(?>(?:%YAML[: ](?>[\\d.]+)(?>[^\\n]*)\\n(?>(?:(?>[ \\t]*)(?>(?:#(?>[^\\n]*))?)\\n)*))?)", value);
    // document markers and the properties of the root node are only found at the top level, not in nested blocks
    if (this.totalNumberOfLines !== null) return value;
    // remove start of the document marker (---), with the YAML 1.0 directives, or the node properties and block scalar header that can follow it alone
    const start = pregReplace(
      "^---(?:(?>[ \\t]+)(?>(?:%(?>[^\\n]*)|(?>(?:(?:[!&](?>[^ \\t\\n]*)|[|>](?>[-+0-9]*))(?>[ \\t]*))+)(?=(?>(?:#(?>[^\\n]*))?)(?:\\n|\\z)))?)|(?=\\n)|\\z)",
      "",
      value,
      () => "",
    );
    value = start.result;
    // remove the anchor of the root node, as nothing can refer to it
    value = pregReplace("^(?P<pre>(?>(?:![^! \\t\\n](?>[^ \\t\\n]*)(?>[ \\t]+))?))&(?>[^ \\t\\n]+)(?:(?>[ \\t]+)|(?=\\n)|\\z)", "", value, (m) => m.groups?.pre ?? "").result;
    // remove the lines left without content
    const offset = this.offset;
    value = this.removeLeadingLines("^(?>(?:(?>[ \\t]*)(?>(?:#(?>[^\\n]*))?)\\n)+)", value);
    marker.hasContentOnStartMarkerLine = start.count === 1 && offset === this.offset;
    // remove end of the document marker (...), which can only be followed by comments
    value = pregReplace("^\\.\\.\\.(?>(?:(?>[ \\t]+)(?>(?:#(?>[^\\n]*))?))?)(?>(?:\\n(?>[ \\t]*)(?>(?:#(?>[^\\n]*))?))*)\\z", "m", value, () => "").result;
    const multi = pregMatch("^(?:---|\\.\\.\\.)(?>(?:[ \\t](?>[^\\n]*))?)$", value, "m");
    if (multi) throw new SymfonyYamlParseException("Multiple documents are not supported.", this.offset + substrCount(value, "\n", 0, multi.index) + 1, multi[0]);
    return value;
  }

  /** isNextLineInBlockScalar() */
  private isNextLineInBlockScalar(value: string): boolean {
    if (this.currentLineNb + 1 >= this.numberOfParsedLines || !pregMatch(`:[ \\t]+(?:${TAG_PATTERN}[ \\t]+)?${BLOCK_SCALAR_HEADER_PATTERN}$`, value)) return false;
    const nextLine = this.lines[this.currentLineNb + 1]!;
    return trim(nextLine, " ") === "" || strspn(nextLine, " ") > this.getCurrentLineIndentation();
  }

  /** moveAnchorBeforeTag(): "!tag &anchor value" → "&anchor !tag value" (not a built-in tag). */
  private moveAnchorBeforeTag(value: string): string {
    if (value.startsWith("!!")) return value;
    return pregReplace(`^${TAG_PATTERN}(?> +)(?P<anchor>&(?>[^ ]+))`, "", value, (m) => `${m.groups!.anchor} ${m.groups!.tag}`).result;
  }

  private removeLeadingLines(pattern: string, value: string): string {
    const trimmed = pregReplace(pattern, "", value, () => "").result;
    this.offset += substrCount(value, "\n") - substrCount(trimmed, "\n");
    return trimmed;
  }

  private isNextLineUnIndentedCollection(): boolean {
    const currentIndentation = this.getCurrentLineIndentation();
    let movements = 0;
    let EOF: boolean;
    do {
      EOF = !this.moveToNextLine();
      if (!EOF) ++movements;
    } while (!EOF && (this.isCurrentLineEmpty() || this.isCurrentLineComment()));
    const ret = !EOF && this.getCurrentLineIndentation() === currentIndentation && this.isStringUnIndentedCollectionItem();
    for (let i = 0; i < movements; ++i) this.moveToPreviousLine();
    return ret;
  }

  private isStringUnIndentedCollectionItem(): boolean {
    return rtrim(this.currentLine) === "-" || this.currentLine.startsWith("- ");
  }

  /** trimTag() */
  private trimTag(value: string): string {
    if (value[0] === "!") return ltrim(substr(value, 1, strcspn(value, " \r\n", 1)), " ");
    return value;
  }

  /** getLineTag() without PARSE_CUSTOM_TAGS: null, or Symfony's error for the tag. */
  private getLineTag(value: string, nextLineCheck: boolean): string | null {
    if (value === "" || value[0] !== "!") return null;
    const matches = pregMatch(`^${TAG_PATTERN}(?>(?:(?> +)(?>(?:#(?>.*))?))?)$`, value);
    if (!matches) return null;
    // unlike a sequence item, the value of a mapping key can also be a sequence that is not indented
    if (nextLineCheck && !this.isNextLineIndented() && (this.isStringUnIndentedCollectionItem() || !this.isNextLineUnIndentedCollection())) return null;
    const tag = matches.groups.tag!.slice(1);
    // Built-in tags
    if (tag !== "" && tag[0] === "!") {
      // "!!str" and "!!binary" can be resolved as inline scalars when they don't apply to a nested block
      if (!nextLineCheck && (tag === "!str" || tag === "!binary") && !this.isNextLineIndented()) return null;
      throw new SymfonyYamlParseException(`The built-in tag "!${tag}" is not implemented.`, this.getRealCurrentLineNb() + 1, value);
    }
    throw new SymfonyYamlParseException(`Tags support is not enabled. You must use the flag "Yaml::PARSE_CUSTOM_TAGS" to use "${matches.groups.tag}".`, this.getRealCurrentLineNb() + 1, value);
  }

  /** lexInlineQuotedString() */
  private lexInlineQuotedString(cursor: { at: number }): string {
    const quotation = this.currentLine[cursor.at]!;
    let value = quotation;
    ++cursor.at;
    let previousLineWasNewline = true;
    let previousLineWasTerminatedWithBackslash = false;
    let lineNumber = 0;
    do {
      if (++lineNumber > 1) cursor.at += strspn(this.currentLine, " \t", cursor.at);
      const isBlankLine = trim(this.currentLine, " \t") === "";
      if (isBlankLine) value += "\n";
      else if (!previousLineWasNewline && !previousLineWasTerminatedWithBackslash) value += " ";
      let line = "";
      let escapedLength = 0;
      for (; this.currentLine.length > cursor.at; ++cursor.at) {
        const c = this.currentLine[cursor.at]!;
        if (c === "\\") {
          if (quotation === "'") line += "\\";
          else if (++cursor.at < this.currentLine.length) {
            line += `\\${this.currentLine[cursor.at]}`;
            escapedLength = line.length;
          }
        } else if (c === quotation) {
          ++cursor.at;
          if (quotation === "'" && this.currentLine[cursor.at] === "'") {
            line += "''";
            continue;
          }
          return value + line + quotation;
        } else {
          line += c;
        }
      }
      if (isBlankLine) {
        previousLineWasNewline = true;
        previousLineWasTerminatedWithBackslash = false;
      } else if (quotation === '"' && (this.currentLine.length - rtrim(this.currentLine, "\\").length) % 2 === 1) {
        previousLineWasNewline = false;
        previousLineWasTerminatedWithBackslash = true;
      } else {
        previousLineWasNewline = false;
        previousLineWasTerminatedWithBackslash = false;
        // trailing white space is removed when the line is folded, unless it is escaped
        line = substr(line, 0, escapedLength) + rtrim(substr(line, escapedLength), " \t");
      }
      value += line;
      if (this.hasMoreLines()) cursor.at = 0;
    } while (this.moveToNextLine());
    throw new SymfonyYamlParseException("Malformed inline YAML string.");
  }

  private lexUnquotedString(cursor: { at: number }): string {
    const offset = cursor.at;
    while (cursor.at < this.currentLine.length) {
      const c = this.currentLine[cursor.at]!;
      if ("[]{},:".includes(c)) break;
      if ((c === " " || c === "\t") && this.currentLine[cursor.at + 1] === "#") break;
      ++cursor.at;
    }
    if (cursor.at === offset) throw new SymfonyYamlParseException("Malformed unquoted YAML string.");
    return substr(this.currentLine, offset, cursor.at - offset);
  }

  private lexInlineAnchorOrAlias(cursor: { at: number }): string {
    const offset = cursor.at;
    ++cursor.at;
    while (cursor.at < this.currentLine.length && !" \t,[]{}".includes(this.currentLine[cursor.at]!)) ++cursor.at;
    return substr(this.currentLine, offset, cursor.at - offset);
  }

  /** lexInlineStructure() */
  private lexInlineStructure(cursor: { at: number }, closingTag: string, consumeUntilEol = true): string {
    this.state.enterNestingLevel(this.getRealCurrentLineNb() + 1, this.currentLine);
    try {
      return this.doLexInlineStructure(cursor, closingTag, consumeUntilEol);
    } finally {
      this.state.leaveNestingLevel();
    }
  }

  private doLexInlineStructure(cursor: { at: number }, closingTag: string, consumeUntilEol: boolean): string {
    let value = this.currentLine[cursor.at]!;
    ++cursor.at;
    do {
      this.consumeWhitespaces(cursor);
      inner: while (cursor.at < this.currentLine.length) {
        const c = this.currentLine[cursor.at]!;
        switch (c) {
          case '"':
          case "'":
            value += this.lexInlineQuotedString(cursor);
            break;
          case ":":
          case ",":
            value += c;
            ++cursor.at;
            break;
          case "{":
            value += this.lexInlineStructure(cursor, "}", false);
            break;
          case "[":
            value += this.lexInlineStructure(cursor, "]", false);
            break;
          case "&":
          case "*":
            value += this.lexInlineAnchorOrAlias(cursor);
            break;
          case "#":
            break inner;
          default:
            if (c === closingTag) {
              value += c;
              ++cursor.at;
              if (consumeUntilEol && cursor.at < this.currentLine.length) {
                const whitespaces = strspn(this.currentLine, " ", cursor.at) + cursor.at;
                if (whitespaces < this.currentLine.length && this.currentLine[whitespaces] !== "#") throw new SymfonyYamlParseException(`Unexpected token "${trim(substr(this.currentLine, cursor.at))}".`);
              }
              return value;
            }
            value += this.lexUnquotedString(cursor);
        }
        if (this.consumeWhitespaces(cursor)) value += " ";
      }
      if (this.hasMoreLines()) cursor.at = 0;
    } while (this.moveToNextLine());
    throw new SymfonyYamlParseException("Malformed inline YAML string.");
  }

  private consumeWhitespaces(cursor: { at: number }): boolean {
    let whitespacesConsumed = 0;
    do {
      const n = strspn(this.currentLine, " \t", cursor.at);
      whitespacesConsumed += n;
      cursor.at += n;
      if (cursor.at < this.currentLine.length) return whitespacesConsumed > 0;
      if (this.hasMoreLines()) cursor.at = 0;
    } while (this.moveToNextLine());
    return whitespacesConsumed > 0;
  }
}

/** (int) of a block scalar's modifiers: the leading integer. */
function phpIntCast(s: string): number {
  const m = /^[ \t\n\r\v\f]*([+-]?[0-9]+)/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** (float) $string */
function phpFloatCast(s: string): number {
  const m = /^[ \t\n\r\v\f]*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

function phpType(v: YamlValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number" || typeof v === "bigint") return "int";
  if (v instanceof PhpFloat) return "float";
  if (typeof v === "string") return "string";
  return "Symfony\\Component\\Yaml\\Tag\\TaggedValue";
}

/** Parser::parse() on a byte string. */
export function parseBytes(bytes: string): YamlValue {
  const state = new ParserState();
  const parser = new Parser(state);
  return parser.doParse(bytes);
}
