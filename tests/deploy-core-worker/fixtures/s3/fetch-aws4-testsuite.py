import json, os, ssl, sys, urllib.request

# AWS's Signature Version 4 test suite, as botocore vendors it (aws4_testsuite).
BASE = "https://raw.githubusercontent.com/boto/botocore/develop/tests/unit/auth/aws4_testsuite/"
NAMES = [
    "get-vanilla", "get-vanilla-query", "get-vanilla-empty-query-key", "get-vanilla-query-order-key",
    "get-vanilla-query-order-key-case", "get-vanilla-query-order-value", "get-vanilla-query-unreserved",
    "get-vanilla-utf8-query", "get-unreserved", "get-utf8", "get-space",
    "get-header-key-duplicate", "get-header-value-multiline", "get-header-value-order", "get-header-value-trim",
    "post-vanilla", "post-vanilla-query", "post-header-key-case", "post-header-key-sort", "post-header-value-case",
    "post-x-www-form-urlencoded", "post-x-www-form-urlencoded-parameters",
]
ctx = ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
out = {}
for name in NAMES:
    case = {}
    for ext in ["req", "creq", "sts", "authz"]:
        try:
            with urllib.request.urlopen(BASE + name + "/" + name + "." + ext, context=ctx) as r:
                case[ext] = r.read().decode("utf-8")
        except Exception as e:
            print(name, ext, e, file=sys.stderr)
    if len(case) == 4:
        out[name] = case
json.dump(out, open(sys.argv[1], "w"), indent=2, ensure_ascii=False)
print(len(out), "cases")
