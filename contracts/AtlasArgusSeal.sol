// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AtlasArgusSeal
/// @notice ATLAS ve ARGUS bulguları için commit-reveal mührü. Reveal sırasında
///         keccak256(bulgu + salt) zincir üzerinde yeniden hesaplanır ve daha önce
///         commit edilen hash'le uyuşmazsa işlem reddedilir.
/// @dev Kanıtın sınırı: mühür, bir agent'ın diğerinin cevabı açıklandıktan sonra
///      fikrini değiştirmediğini kanıtlar. ARGUS'un ATLAS'ı görmediğini kod yapısı sağlar.
contract AtlasArgusSeal {
    struct Commitment {
        bytes32 binding; // keccak256(roundId, agent, phase): hash'i bu tura/agent'a bağlar
        address sealer;
        uint64 committedAt;
        uint64 revealedAt;
    }

    /// @notice hash => commit kaydı (salt rastgele 32 bayt olduğu için hash her mühürde benzersiz)
    mapping(bytes32 => Commitment) public commitments;

    event Committed(bytes32 indexed hash, string roundId, string agent, string phase, address sealer);
    event Revealed(bytes32 indexed hash, string roundId, string agent, string phase, string finding, string salt);

    function bindingOf(string calldata roundId, string calldata agent, string calldata phase) public pure returns (bytes32) {
        return keccak256(abi.encode(roundId, agent, phase));
    }

    function commit(string calldata roundId, string calldata agent, string calldata phase, bytes32 hash) external {
        require(hash != bytes32(0), "bos hash");
        require(commitments[hash].committedAt == 0, "zaten commit edildi");
        commitments[hash] = Commitment(bindingOf(roundId, agent, phase), msg.sender, uint64(block.timestamp), 0);
        emit Committed(hash, roundId, agent, phase, msg.sender);
    }

    /// @param finding canonical JSON bulgu (anahtarlar sıralı, boşluksuz)
    /// @param salt    commit'te kullanılan salt ("0x..." metni)
    function reveal(
        string calldata roundId,
        string calldata agent,
        string calldata phase,
        string calldata finding,
        string calldata salt
    ) external {
        bytes32 hash = keccak256(abi.encodePacked(finding, salt));
        Commitment storage c = commitments[hash];
        require(c.committedAt != 0, "hash uyusmuyor veya commit yok");
        require(c.revealedAt == 0, "zaten reveal edildi");
        require(c.sealer == msg.sender, "yalnizca commit eden reveal edebilir");
        require(c.binding == bindingOf(roundId, agent, phase), "tur/agent/asama uyusmuyor");
        c.revealedAt = uint64(block.timestamp);
        emit Revealed(hash, roundId, agent, phase, finding, salt);
    }

    function isRevealed(bytes32 hash) external view returns (bool) {
        return commitments[hash].revealedAt != 0;
    }
}
