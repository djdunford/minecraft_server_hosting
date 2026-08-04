# Satisfactory Server

## Install on EC2

```bash
sudo add-apt-repository multiverse; sudo dpkg --add-architecture i386; sudo apt update
sudo apt install steamcmd -y
steamcmd +force_install_dir ~/SatisfactoryDedicatedServer +login anonymous +app_update 1690800 validate +quit
cd SatisfactoryDedicatedServer/
./FactoryServer.sh 
```

```bash
sudo apt -y update
sudo apt -y upgrade

```