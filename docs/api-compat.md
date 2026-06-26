# API Compatibility

The Workers keep XBoard-style response envelopes:

```json
{ "data": {} }
```

Errors use:

```json
{ "message": "Error", "errors": "Error", "code": 400 }
```

Payment-related endpoints return disabled placeholders until payment support is implemented.
