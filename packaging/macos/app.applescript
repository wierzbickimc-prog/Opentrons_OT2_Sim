-- OT-2 Manufacturing Tools: starts the local server (launcher.sh) and opens it in the browser.
-- The window stays open while the tools run; Quit stops the server.

property appName : "OT-2 Manufacturing Tools"

on launcher()
	return quoted form of (POSIX path of (path to resource "launcher.sh"))
end launcher

on askForPin(isFirstRun)
	set prompt to "Robot PIN (optional)" & return & return & "A PIN turns on direct upload to an OT-2 and live calibration from this Mac. Anyone using these tools on this Mac will need it. Leave it blank to keep both off."
	if isFirstRun then set prompt to "Setup is complete." & return & return & prompt
	set reply to display dialog prompt default answer "" with hidden answer buttons {"No PIN", "Save PIN"} default button 2 with title appName
	set pin to text returned of reply
	if button returned of reply is "No PIN" then set pin to ""
	do shell script "printf %s " & quoted form of pin & " | " & launcher() & " set-pin"
end askForPin

on run
	with timeout of 86400 seconds
		set firstRun to true
		try
			do shell script launcher() & " needs-setup"
		on error
			set firstRun to false
		end try
		if firstRun then display notification "Setting up for the first time. This takes about a minute." with title appName
		try
			set appURL to do shell script launcher() & " start"
		on error message
			display dialog appName & " could not start." & return & return & message buttons {"OK"} default button 1 with icon stop with title appName
			return
		end try
		try
			do shell script launcher() & " pin-asked"
		on error
			my askForPin(true)
			do shell script launcher() & " stop"
			set appURL to do shell script launcher() & " start"
		end try
		open location appURL
		repeat
			set choice to button returned of (display dialog appName & " is running at" & return & appURL & return & return & "Keep this window open while you work. Quit stops the tools." buttons {"Quit", "Robot PIN…", "Open in browser"} default button 3 with title appName)
			if choice is "Quit" then exit repeat
			if choice is "Robot PIN…" then
				my askForPin(false)
				do shell script launcher() & " stop"
				set appURL to do shell script launcher() & " start"
			else
				open location appURL
			end if
		end repeat
		do shell script launcher() & " stop"
	end timeout
end run

on quit
	try
		do shell script launcher() & " stop"
	end try
	continue quit
end quit
