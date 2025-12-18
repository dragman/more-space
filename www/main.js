import init, { init_game, tick, greeting, generate_system_report } from "../pkg/more_space.js";

const output = document.getElementById("output");

function showMessage(text, isError = false) {
    if (!output) return;
    output.textContent = text;
    output.style.color = isError ? "crimson" : "";
}

async function run() {
    try {
        await init();
        const seed = BigInt(Date.now());
        init_game(seed);

        const result = greeting();
        const system = generate_system_report(seed);
        showMessage(`${result}\n\nSystem:\n${system}`);
    } catch (err) {
        const msg = err instanceof Error ? err.stack || err.message : String(err);
        console.error(err);
        showMessage(`Error: ${msg}`, true);
    }
}

run();
