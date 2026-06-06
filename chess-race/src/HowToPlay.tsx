export default function HowToPlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>How to play</h2>

        <div className="howto-section">
          <h3>The race</h3>
          <p>
            Everyone races the <b>same chess piece</b> (the host picks it) from
            the start to the flag, 100 tiles away. You move forward only, by
            that piece's rules - slide a rook/bishop/queen along a ray, or jump
            a knight. Click a highlighted tile to move. There's a short cooldown
            between moves.
          </p>
        </div>

        <div className="howto-section">
          <h3>Hazards</h3>
          <ul>
            <li>
              <span className="legend-wall" /> <b>Wall</b> - blocks rooks,
              bishops and queens; knights jump over it. Nobody can land on it.
            </li>
            <li>
              <span className="pawn-mark mini">♟</span> <b>Pawn mine</b> -
              threatens its two forward-diagonal tiles (shown{" "}
              <span className="threat-text">red</span>). Land on a red tile and
              you're knocked back and stunned. Land on the pawn itself to defuse
              it.
            </li>
          </ul>
        </div>

        <div className="howto-section">
          <h3>Power-ups (land on one to grab it, then press Use)</h3>
          <ul>
            <li>
              <span className="item-promotion">♛</span> <b>Promotion</b> -
              become a Queen for a few seconds (move any direction forward).
            </li>
            <li>
              <span className="item-freeze">❄</span> <b>Freeze</b> - freeze the
              current leader so they can't move briefly.
            </li>
            <li>
              <span className="bomb mini" /> <b>Mine</b> - drop a pawn mine
              right behind you to trip up chasers.
            </li>
          </ul>
        </div>

        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}
