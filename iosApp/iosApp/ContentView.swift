import Shared
import SwiftUI

struct ContentView: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = Int64(context.date.timeIntervalSince1970 * 1000)
            List {
                LabeledContent("Time in Sofia", value: SofiaTime.shared.at(epochMs: now).hhmmss)
                LabeledContent("Service day", value: SofiaTime.shared.serviceTime(epochMs: now).day)
            }
            .navigationTitle("Sofia Transit")
        }
    }
}
