<?php
// Produces expected.json from Coolify's own PHP source (coollabsio/coolify@91b7e3e).
// Usage: php generate.php /path/to/coolify > expected.json
// See README.md.

$coolify = rtrim($argv[1] ?? '', '/');
if ($coolify === '' || ! is_file("$coolify/bootstrap/helpers/shared.php")) {
    fwrite(STDERR, "usage: php generate.php /path/to/coolify\n");
    exit(1);
}

/** The source of one top-level function of a helper file. */
function functionSource(string $file, string $name): string
{
    if (preg_match('/^function '.preg_quote($name, '/').'\(.*?^}$/ms', file_get_contents($file), $m) !== 1) {
        throw new RuntimeException("function $name not found");
    }

    return $m[0];
}

/** The source of one method of a class file, as a top-level function. */
function methodSource(string $file, string $name): string
{
    if (preg_match('/^    (?:public|private|protected)(?: static)? function '.preg_quote($name, '/').'\(.*?^    }$/ms', file_get_contents($file), $m) !== 1) {
        throw new RuntimeException("method $name not found");
    }

    return preg_replace('/^    (?:public|private|protected)(?: static)? function/', 'function', $m[0]);
}

/** A constant of bootstrap/helpers/constants.php, as PHP source. */
function constantSource(string $file, string $name): string
{
    if (preg_match('/^const '.preg_quote($name, '/').' = .*?;$/ms', file_get_contents($file), $m) !== 1) {
        throw new RuntimeException("constant $name not found");
    }

    return $m[0];
}

$shared = "$coolify/bootstrap/helpers/shared.php";
$model = "$coolify/app/Models/EnvironmentVariable.php";
$constants = "$coolify/bootstrap/helpers/constants.php";

// The model classes the helpers name in their signatures: only what formatEnvVariableForDevView() reads.
$code = <<<'PHP'
namespace App\Models {
    class EnvironmentVariable {
        public const DEV_VIEW_FLAG_DEFAULTS = ['literal' => false, 'buildtime' => true, 'runtime' => true];
        public function __construct(public string $key, public ?string $value, public bool $is_shown_once = false, public bool $is_multiline = false, public bool $is_literal = false, public bool $is_buildtime = true, public bool $is_runtime = true) {}
    }
    class SharedEnvironmentVariable {
        public const DEV_VIEW_FLAG_DEFAULTS = ['literal' => false];
    }
}
namespace {
    use App\Models\EnvironmentVariable;
    use App\Models\SharedEnvironmentVariable;

PHP;
foreach (['parseEnvFormatToArray', 'formatEnvValueForDevView', 'formatEnvVariableForDevView', 'parseEnvDevView'] as $name) {
    $code .= functionSource($shared, $name)."\n";
}
$code .= methodSource($model, 'withoutEdgeLineBreaks')."\n";
$code .= constantSource($constants, 'SHARED_VARIABLE_TYPES')."\n";
$code .= constantSource($constants, 'SHARED_VARIABLE_REFERENCE_PATTERN')."\n";
$code .= "}\n";
eval($code);

use App\Models\EnvironmentVariable;

$flagDefaults = EnvironmentVariable::DEV_VIEW_FLAG_DEFAULTS;

/** PHP arrays keep insertion order; JSON objects need not. Entries as a list. */
function entries(array $parsed): array
{
    $out = [];
    foreach ($parsed as $key => $data) {
        $out[] = ['key' => (string) $key] + $data;
    }

    return $out;
}

$envFiles = [
    'simple' => "A=1\nB=two",
    'empty value' => "EMPTY=\nNEXT=x",
    'no equals sign is skipped' => "JUSTAKEY\nA=1",
    'blank lines and comment lines' => "\n# a comment\nA=1\n\n#B=2\n",
    'indented comment is not a comment' => "  # not a comment=x\nA=1",
    'equals in value' => 'URL=postgres://u:p@h/db?sslmode=require&x=1',
    'key keeps its spaces' => ' SPACED = v ',
    'export prefix is part of the key' => 'export FOO=bar',
    'unquoted value is trimmed' => "A=   padded   \nB=\ttabbed\t",
    'unquoted inline comment needs whitespace before #' => "A=value #comment\nB=value#notcomment\nC=value   #  spaced comment  \nD=value #\nE=a\t#tab comment",
    'unquoted comment only' => 'A= #only comment',
    'unquoted with two hashes' => 'A=one #two #three',
    'double quoted' => 'A="hello world"',
    'double quoted keeps edge spaces' => 'A="  padded  "',
    'double quoted with hash inside' => 'A="value #not a comment"',
    'double quoted then comment' => 'A="value" # the comment',
    'double quoted then comment without space' => 'A="value"#tight',
    'double quoted then text without hash' => 'A="value" trailing',
    'double quoted ends at the first quote, escapes are not read' => 'A="say \"hi\" now" # c',
    'double quoted without closing quote' => 'A="unterminated value # x',
    'double quoted empty' => 'A=""',
    'single quoted' => "A='hello world'",
    'single quoted with double quotes inside' => "A='say \"hi\"'",
    'single quoted then comment' => "A='v' #c",
    'single quoted without closing quote' => "A='unterminated",
    'single quoted empty then empty comment' => "A='' #",
    'quote not at the start is literal' => 'A=it"s "quoted" here',
    'backslashes are literal' => 'A=line\nbreak\ttab\\\\end',
    'dollar signs are literal' => 'A=$OTHER ${BRACED} $$',
    'multiline quoted value is cut at the line end' => "A=\"first\nsecond\"\nB=2",
    'duplicate key: the last value, the first position' => "A=1\nB=2\nA=3 #again",
    'carriage returns' => "A=1\r\nB=\"two\"\r\nC='three' # c\r\n",
    'empty key' => '=value',
    'shared variable reference' => 'A={{team.SECRET}}',
    'unicode' => 'A=žluťoučký kůň #poznámka',
    'no-break space before # is not whitespace' => "A=value\u{00A0}#x",
    'empty text' => '',
];

$devViews = [
    'no directives' => "A=1\nB=2",
    'literal' => "# coolify: literal\nA=\$x",
    'all flags' => "# coolify: literal buildtime=false runtime=false\nA=1\nB=2",
    'explicit true and false' => "# coolify: literal=false buildtime=true\nA=1",
    'extra whitespace between flags' => "# coolify:   literal \t runtime=false  \nA=1",
    'directive without space after the colon' => "# coolify:literal\nA=1",
    'a plain comment is not a directive' => "# coolify literal\nA=1\n#coolify: literal\nB=2",
    'directive applies to its line only' => "# coolify: literal\nA=1\nB=2",
    'duplicate key: the last directive wins, settings reset' => "# coolify: literal\nA=1\nA=2",
    'repeated flag: the last wins' => "# coolify: literal literal=false\nA=1",
    'directive with a carriage return' => "# coolify: literal\r\nA=1\r\n",
    'error: no flags' => "# coolify:\nA=1",
    'error: no flags, only spaces' => "A=0\n# coolify:   \nA=1",
    'error: unknown flag' => "# coolify: multiline\nA=1",
    'error: bad value' => "# coolify: literal=yes\nA=1",
    'error: empty value' => "# coolify: literal=\nA=1",
    'error: directive before a blank line' => "# coolify: literal\n\nA=1",
    'error: directive before a comment' => "A=1\n\n# coolify: literal\n# note\nB=1",
    'error: directive before a line without =' => "# coolify: literal\nNOEQUALS",
    'error: two directives' => "# coolify: literal\n# coolify: runtime=false\nA=1",
    'error: directive on the last line' => "A=1\n# coolify: literal",
    'error: directive with carriage return before blank' => "# coolify: literal\r\n\r\nA=1",
    'null text' => null,
];

$values = [
    null, '', 'plain', 'with space', ' leading', 'trailing ', "\ttab", 'a #hash', 'a#hash', "a\t#hash", '"quoted"', "'quoted'",
    '"both\' kinds', "it's", ' it\'s padded', ' "both" \'kinds\' ', "line\nbreak", "trailing newline\n", 'say "hi" #now', '#starts with hash', '=equals',
    "nbsp\u{00A0}", "\0nul",
];

$variables = [
    ['key' => 'PLAIN', 'value' => 'v'],
    ['key' => 'EMPTY', 'value' => null],
    ['key' => 'SPACED', 'value' => ' padded '],
    ['key' => 'LOCKED', 'value' => 'secret', 'is_shown_once' => true],
    ['key' => 'MULTI', 'value' => "a\nb", 'is_multiline' => true],
    ['key' => 'MULTI_FLAG_ONLY', 'value' => 'one line', 'is_multiline' => true],
    ['key' => 'UNSHOWABLE', 'value' => ' "both" \'kinds\' '],
    ['key' => 'BREAK', 'value' => "a\nb"],
    ['key' => 'LITERAL', 'value' => '$x', 'is_literal' => true],
    ['key' => 'NO_BUILD', 'value' => 'v', 'is_buildtime' => false],
    ['key' => 'NO_RUN', 'value' => 'v', 'is_runtime' => false],
    ['key' => 'ALL', 'value' => 'a #b', 'is_literal' => true, 'is_buildtime' => false, 'is_runtime' => false],
    ['key' => 'LOCKED_LITERAL', 'value' => 'v', 'is_shown_once' => true, 'is_literal' => true],
];

$edgeLineBreaks = ['', 'plain', "\nplain\n", "\r\nplain\r\n", '  spaced  ', "\n  spaced\t\n", "a\nb", "a\nb\n", "\n\na\nb\n", "\n", "\r\n\r\n", "a\rb\n", "-----BEGIN KEY-----\nabc\n-----END KEY-----\n"];

$references = [
    '{{team.KEY}}', '{{ team.KEY }}', "{{\tproject.DB_URL\n}}", 'prefix {{environment.A}} middle {{server.B}} suffix', '{{team.A}}{{team.A}}', '{{unknown.KEY}}',
    '{{team.}}', '{{team}}', '{{ team . KEY }}', '{{team.KEY.WITH.DOTS}}', '{{team.a-b/c}}', '{team.KEY}', '{{{team.KEY}}}', '{{team.KEY}', 'no reference', '', '{{TEAM.KEY}}',
    '{{team.KEY }} {{project.KEY}}', '{{vault.SECRET}}',
];

$sharedReferenceValues = [
    '{{team.KEY}}', ' {{ team.KEY }} ', "{{project.A}}\n", 'x{{team.KEY}}', '{{team.KEY}}x', '{{team.A}} and {{team.B}}', '{{unknown.KEY}}', '{{team}}', '{{server.}}',
    "{{environment.A\nB}}", '', '   ', 'plain', '{{vault.KEY}}', '{{ server.X}}',
];

$out = [
    'parseEnvFormatToArray' => [],
    'parseEnvDevView' => [],
    'formatEnvValueForDevView' => [],
    'formatEnvVariableForDevView' => [],
    'withoutEdgeLineBreaks' => [],
    'sharedVariableReferences' => [],
    'isSharedReference' => [],
];
foreach ($envFiles as $name => $input) {
    $out['parseEnvFormatToArray'][] = ['name' => $name, 'input' => $input, 'expected' => entries(parseEnvFormatToArray($input))];
}
foreach ($devViews as $name => $input) {
    try {
        $out['parseEnvDevView'][] = ['name' => $name, 'input' => $input, 'expected' => entries(parseEnvDevView($input, $flagDefaults))];
    } catch (InvalidArgumentException $e) {
        $out['parseEnvDevView'][] = ['name' => $name, 'input' => $input, 'error' => $e->getMessage()];
    }
}
foreach ($values as $value) {
    $formatted = formatEnvValueForDevView($value);
    $case = ['input' => $value, 'expected' => $formatted];
    if ($formatted !== null) {
        // What the developer view reads back from the line it shows.
        $case['readBack'] = parseEnvFormatToArray("K=$formatted")['K']['value'];
    }
    $out['formatEnvValueForDevView'][] = $case;
}
foreach ($variables as $v) {
    $model = new EnvironmentVariable($v['key'], $v['value'], $v['is_shown_once'] ?? false, $v['is_multiline'] ?? false, $v['is_literal'] ?? false, $v['is_buildtime'] ?? true, $v['is_runtime'] ?? true);
    $out['formatEnvVariableForDevView'][] = ['variable' => get_object_vars($model), 'canView' => formatEnvVariableForDevView($model, true), 'cannotView' => formatEnvVariableForDevView($model, false)];
}
foreach ($edgeLineBreaks as $value) {
    $out['withoutEdgeLineBreaks'][] = ['input' => $value, 'expected' => withoutEdgeLineBreaks($value)];
}
foreach ($references as $value) {
    // EnvironmentVariable::sharedVariableReferences()
    preg_match_all(SHARED_VARIABLE_REFERENCE_PATTERN, (string) $value, $matches, PREG_SET_ORDER);
    $out['sharedVariableReferences'][] = ['input' => $value, 'expected' => array_map(fn (array $m): array => ['reference' => $m[0], 'type' => $m[1], 'key' => $m[2]], $matches)];
}
foreach ($sharedReferenceValues as $value) {
    // EnvironmentVariable::isSharedReference(), with blank() as Laravel defines it for a string.
    $types = implode('|', SHARED_VARIABLE_TYPES);
    $blank = trim($value) === '';
    $out['isSharedReference'][] = ['input' => $value, 'expected' => ! $blank && preg_match('/^{{\s*(?:'.$types.')\..*}}$/s', trim($value)) === 1];
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
