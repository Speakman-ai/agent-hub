// Command starter is the entrypoint for the Go + cobra starter CLI.
package main

import (
	"os"

	"example.com/starter/cmd"
)

func main() {
	if err := cmd.NewRootCommand().Execute(); err != nil {
		os.Exit(1)
	}
}
