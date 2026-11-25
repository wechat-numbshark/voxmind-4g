export function initialState() {
  return { step: "ready", speech: null, proposal: null, record: null };
}

export function reduce(state, action, item) {
  if (action === "reset") return initialState();
  if (action === "show-speech" && state.step === "ready") {
    return { step: "speech", speech: item.speech, proposal: null, record: null };
  }
  if (action === "propose" && state.step === "speech") {
    return { step: "proposal", speech: state.speech, proposal: item.proposal, record: null };
  }
  if (action === "confirm" && state.step === "proposal") {
    return { step: "recorded", speech: state.speech, proposal: state.proposal, record: item.record };
  }
  return state;
}
