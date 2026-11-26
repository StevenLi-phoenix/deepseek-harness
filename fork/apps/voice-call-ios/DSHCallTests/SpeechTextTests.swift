import XCTest
@testable import DSHCall

final class SpeechTextTests: XCTestCase {
    // MARK: - Voice language

    func testVoiceLanguage() {
        XCTAssertEqual(SpeechLanguage.voiceLanguage(for: "The build finished without errors."), SpeechLanguage.english)
        XCTAssertEqual(SpeechLanguage.voiceLanguage(for: "构建已经完成了。"), SpeechLanguage.chinese)
        XCTAssertEqual(SpeechLanguage.voiceLanguage(for: "PR 已经合并"), SpeechLanguage.chinese)
        XCTAssertEqual(SpeechLanguage.voiceLanguage(for: "Merged PR 1234 into main 了"), SpeechLanguage.english)
        XCTAssertEqual(SpeechLanguage.voiceLanguage(for: "12:30"), SpeechLanguage.chinese)
    }

    // MARK: - Echo guard

    func testEchoOfTheSpokenText() {
        XCTAssertTrue(EchoGuard.isLikelyEcho(partial: "今天天气很好", spoken: "今天天气很好，适合出门。"))
        XCTAssertTrue(EchoGuard.isLikelyEcho(partial: "Hello, World", spoken: "hello world!"))
        XCTAssertTrue(EchoGuard.isLikelyEcho(partial: "天气很好", spoken: "今天天气很好"))
    }

    func testOwnerSpeechIsNotEcho() {
        XCTAssertFalse(EchoGuard.isLikelyEcho(partial: "我想问一下明天的会", spoken: "今天天气很好，适合出门。"))
        XCTAssertFalse(EchoGuard.isLikelyEcho(partial: "stop please", spoken: "The build finished without errors."))
    }

    func testEchoEdgeCases() {
        XCTAssertTrue(EchoGuard.isLikelyEcho(partial: "，。", spoken: "anything"), "punctuation alone carries no speech")
        XCTAssertFalse(EchoGuard.isLikelyEcho(partial: "你好", spoken: ""))
        XCTAssertTrue(EchoGuard.isLikelyEcho(partial: "好", spoken: "你好"))
        XCTAssertFalse(EchoGuard.isLikelyEcho(partial: "停", spoken: "你好"))
    }

    // MARK: - Utterance gate

    func testUtteranceGrowsThenFinishes() {
        var gate = UtteranceGate()
        XCTAssertEqual(gate.heard("明天"), .began)
        XCTAssertTrue(gate.isActive)
        XCTAssertEqual(gate.heard("明天"), .unchanged)
        XCTAssertEqual(gate.heard("明天提醒我开会"), .changed)
        XCTAssertEqual(gate.finish(), "明天提醒我开会")
        XCTAssertFalse(gate.isActive)
        XCTAssertNil(gate.finish())
    }

    func testEmptyPartialDoesNotBegin() {
        var gate = UtteranceGate()
        XCTAssertEqual(gate.heard("   "), .unchanged)
        XCTAssertFalse(gate.isActive)
        XCTAssertNil(gate.finish())
    }

    func testEchoPrefixIsRemoved() {
        var gate = UtteranceGate()
        gate.echo("今天天气很好")
        XCTAssertTrue(gate.heardOnlyEcho)
        XCTAssertEqual(gate.heard("今天天气很好"), .unchanged)
        XCTAssertEqual(gate.heard("今天天气很好，等一下"), .began)
        XCTAssertFalse(gate.heardOnlyEcho)
        XCTAssertEqual(gate.finish(), "等一下")
    }

    func testEchoAfterTheUtteranceBeganIsIgnored() {
        var gate = UtteranceGate()
        XCTAssertEqual(gate.heard("wait"), .began)
        gate.echo("wait")
        XCTAssertEqual(gate.echoPrefix, "")
        XCTAssertEqual(gate.finish(), "wait")
    }

    func testResetClearsEverything() {
        var gate = UtteranceGate()
        gate.echo("x")
        gate.reset()
        XCTAssertFalse(gate.heardOnlyEcho)
        XCTAssertEqual(gate, UtteranceGate())
    }

    func testFinishCutsToTheServerLimit() {
        var gate = UtteranceGate()
        XCTAssertEqual(gate.heard(String(repeating: "话", count: UtteranceGate.maxLength + 500)), .began)
        XCTAssertEqual(gate.finish()?.utf16.count, UtteranceGate.maxLength)
    }
}

final class ActiveCallTests: XCTestCase {
    @MainActor
    private func makeCall(direction: CallMachine.Direction = .incoming) -> ActiveCall {
        ActiveCall(id: UUID(), callId: "id", direction: direction, callerName: "DSH", reason: nil)
    }

    @MainActor
    func testInitialPhaseFollowsDirection() {
        XCTAssertEqual(makeCall(direction: .incoming).phase, .ringing)
        XCTAssertEqual(makeCall(direction: .outgoing).phase, .dialing)
    }

    @MainActor
    func testTranscriptTrimsSkipsEmptyAndKeepsTheNewestLines() {
        let call = makeCall()
        call.appendTranscript(role: .agent, text: "  ")
        XCTAssertTrue(call.transcript.isEmpty)
        for index in 0..<(ActiveCall.transcriptLimit + 5) {
            call.appendTranscript(role: index.isMultiple(of: 2) ? .agent : .owner, text: " line \(index) ")
        }
        XCTAssertEqual(call.transcript.count, ActiveCall.transcriptLimit)
        XCTAssertEqual(call.transcript.first?.text, "line 5")
        XCTAssertEqual(call.transcript.last?.text, "line \(ActiveCall.transcriptLimit + 4)")
        XCTAssertEqual(Set(call.transcript.map(\.id)).count, ActiveCall.transcriptLimit)
    }

    @MainActor
    func testRecentAgentText() {
        let call = makeCall()
        call.appendTranscript(role: .agent, text: "one")
        call.appendTranscript(role: .owner, text: "mine")
        call.appendTranscript(role: .agent, text: "two")
        call.appendTranscript(role: .agent, text: "three")
        XCTAssertEqual(call.recentAgentText(lines: 2), "two three")
    }
}
