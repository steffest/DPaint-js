module.exports = {
    env: {
        browser: true,
        es2021: true,
        node: true,
    },
    extends: ["eslint:recommended", "plugin:prettier/recommended"],
    overrides: [],
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
    },
    rules: {
        curly: ["warn", "multi-line", "consistent"],
        "no-console": ["warn", { allow: ["warn", "error"] }],
        "no-debugger": "warn",
    },
};
