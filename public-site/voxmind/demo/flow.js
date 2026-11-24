export function initialState() {
  return { step: "ready", speech: null, proposal: null, record: null };
}

export function reduce(state, action, seed) {
  if (action === "reset") return initialState();
  if (action === "show-speech" && state.step === "ready") {
    return { step: "speech", speech: seed.speech, proposal: null, record: null };
  }
  if (action === "propose" && state.step === "speech") {
    return { step: "proposal", speech: state.speech, proposal: seed.proposal, record: null };
  }
  if (action === "confirm" && state.step === "proposal") {
    return { step: "recorded", speech: state.speech, proposal: state.proposal, record: seed.record };
  }
  return state;
}
